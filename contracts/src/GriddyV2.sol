// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DrandBeacon} from "./drand/DrandBeacon.sol";

interface IGriddyToken {
    function mint(address to, uint256 amount) external;
}

/// @title GriddyV2 — variable-stake native-token pari-mutuel 5x5 grid
/// @notice Players stake any amount of ETH (>= minStakeWei per new position) on
///         any cells. A drand evmnet beacon — pinned at round start to a round
///         emitted only after betting closes, BLS-verified on-chain — picks the
///         winning cell weighted by stake. Winners split the prize pro-rata to
///         their stake on that cell, so every wei has identical expected value
///         wherever it sits. UUPS-upgradeable.
contract GriddyV2 is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// @dev Namespaced-slot reentrancy guard (OZ 5.6 dropped the storage-based
    ///      upgradeable guard; transient storage isn't guaranteed on all chains)
    bytes32 private constant REENTRANCY_SLOT = keccak256("griddy.v2.reentrancy");

    function _nonReentrantBefore() private {
        bytes32 slot = REENTRANCY_SLOT;
        uint256 status;
        assembly { status := sload(slot) }
        require(status == 0, "Reentrancy");
        assembly { sstore(slot, 1) }
    }

    function _nonReentrantAfter() private {
        bytes32 slot = REENTRANCY_SLOT;
        assembly { sstore(slot, 0) }
    }

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    uint256 public constant GRID_SIZE = 25;
    uint256 public constant BPS_BASE = 10_000;
    uint256 public constant REFUND_DELAY = 30 days;
    uint256 public constant VOID_GRACE = 3 days;
    /// @dev Owner-gated and on a drand-outage timescale on purpose: a
    ///      permissionless or short-timeout re-pin would let a losing staker
    ///      re-roll an already-published beacon. The permissionless liveness
    ///      path is requestVoid/voidStuckRound, which refunds, never re-draws.
    uint256 public constant REPIN_TIMEOUT = 6 hours;
    /// @notice Unique stakers per cell — bounds the auto-pay loop (top-ups free)
    uint256 public constant MAX_STAKERS_PER_CELL = 100;
    uint256 public constant MIN_STAKE_LO = 1e13;
    uint256 public constant MIN_STAKE_HI = 1e16;
    uint256 public constant MAX_RESOLVER_TIP = 1e15;
    /// @notice Gas forwarded on winner/tip pushes; failures escrow to pull
    uint256 public constant PUSH_GAS = 40_000;

    // ─── Linear storage: NEVER reorder, append-only (see __gap) ───
    IGriddyToken public griddyToken;
    DrandBeacon public beacon;
    address public feeRecipient;
    uint256 public minStakeWei;
    uint256 public roundDuration;
    uint256 public beaconGap;
    uint256 public protocolFeeBps;
    uint256 public resolverTipWei;
    uint256 public griddyPerRound;
    uint256 public motherlodePerRound;
    uint256 public bonusRoundOdds;
    uint256 public bonusMultiplier;
    uint256 public bonusReserveBps;
    uint256 public currentRoundId;
    uint256 public accumulatedFees;
    uint256 public pendingRefunds;
    uint256 public pendingWithdrawals;
    uint256 public bonusReserve;
    bool public paused;

    struct Round {
        uint64 startTime;
        uint64 endTime;
        uint64 drandRound;
        uint8 winningCell;
        bool resolved;
        bool isBonusRound;
        uint256 totalStaked;
        uint256 totalStakers;
        uint256 winnerTotal;
        uint256 distributable;
        uint256 griddyBase;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(uint8 => uint256)) public cellTotal;
    mapping(uint256 => mapping(uint8 => address[])) public cellStakers;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) public playerTotalStaked;
    mapping(uint256 => bool) public roundVoided;
    mapping(uint256 => mapping(address => bool)) public refunded;
    mapping(uint256 => uint64) public voidRequestedAt;
    mapping(address => uint256) public unclaimedWinnings;
    uint256[50] private __gap;

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime, uint64 drandRound);
    event Staked(uint256 indexed roundId, address indexed player, uint8 cell, uint256 amount, uint256 playerCellTotal, uint256 cellTotalAfter);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, uint256 winnerTotal, uint256 distributable, bool isBonusRound);
    event WinningsPaid(uint256 indexed roundId, address indexed player, uint256 ethAmount, uint256 griddyAmount);
    event WinningsEscrowed(uint256 indexed roundId, address indexed player, uint256 amount);
    event WinningsWithdrawn(address indexed player, uint256 amount);
    event ResolverTipPaid(uint256 indexed roundId, address indexed resolver, uint256 amount);
    event RewardMintFailed(uint256 indexed roundId, address indexed player, uint256 griddyAmount);
    event EmptyRoundSkipped(uint256 indexed roundId);
    event RoundRepinned(uint256 indexed roundId, uint64 oldDrandRound, uint64 newDrandRound);
    event BonusReserveDeposited(address indexed from, uint256 amount);
    event VoidRequested(uint256 indexed roundId, uint64 executableAt);
    event RoundVoided(uint256 indexed roundId);
    event Refunded(uint256 indexed roundId, address indexed player, uint256 amount);
    event PausedSet(bool paused);
    event ConfigUpdated(string key, uint256 value);
    event FeeRecipientUpdated(address recipient);
    event GriddyTokenUpdated(address token);
    event BeaconUpdated(address oldBeacon, address newBeacon);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address griddyToken_,
        address feeRecipient_,
        address beacon_,
        address owner_
    ) external initializer {
        require(
            griddyToken_ != address(0) && feeRecipient_ != address(0) && beacon_ != address(0) && owner_ != address(0),
            "Zero address"
        );
        __Ownable_init(owner_);
        __Ownable2Step_init();

        griddyToken = IGriddyToken(griddyToken_);
        beacon = DrandBeacon(beacon_);
        feeRecipient = feeRecipient_;
        minStakeWei = 1e14;          // 0.0001 ETH
        roundDuration = 30;
        beaconGap = 10;
        protocolFeeBps = 500;        // 5%
        resolverTipWei = 3e13;       // 0.00003 ETH
        griddyPerRound = 100e18;
        motherlodePerRound = 1000e18;
        bonusRoundOdds = 100;
        bonusMultiplier = 10;
        bonusReserveBps = 5000;
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // Staking
    // ══════════════════════════════════════════════════════════════

    /// @notice Stake ETH on one or more cells of the current round. New
    ///         positions must be >= minStakeWei; top-ups can be any amount.
    function stake(uint256 roundId, uint8[] calldata cells, uint256[] calldata amounts) external payable nonReentrant {
        require(!paused, "Paused");
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp < round.endTime, "Round ended");
        require(cells.length == amounts.length && cells.length > 0 && cells.length <= GRID_SIZE, "Bad arrays");

        uint32 seen;
        uint256 sum;
        for (uint256 i = 0; i < cells.length; i++) {
            uint8 cell = cells[i];
            require(cell < GRID_SIZE, "Invalid cell");
            require(seen & (uint32(1) << cell) == 0, "Dup cell");
            seen |= uint32(1) << cell;
            _stakeOne(roundId, cell, amounts[i]);
            sum += amounts[i];
        }
        require(sum == msg.value, "Value mismatch");

        if (playerTotalStaked[roundId][msg.sender] == 0) {
            round.totalStakers++;
        }
        playerTotalStaked[roundId][msg.sender] += msg.value;
        round.totalStaked += msg.value;
    }

    function _stakeOne(uint256 roundId, uint8 cell, uint256 amount) private {
        require(amount > 0, "Zero amount");
        if (stakeOf[roundId][cell][msg.sender] == 0) {
            require(amount >= minStakeWei, "Below min stake");
            require(cellStakers[roundId][cell].length < MAX_STAKERS_PER_CELL, "Cell full");
            cellStakers[roundId][cell].push(msg.sender);
        }
        stakeOf[roundId][cell][msg.sender] += amount;
        cellTotal[roundId][cell] += amount;
        emit Staked(roundId, msg.sender, cell, amount, stakeOf[roundId][cell][msg.sender], cellTotal[roundId][cell]);
    }

    // ══════════════════════════════════════════════════════════════
    // Resolution — permissionless, drand-verified, pro-rata auto-pay
    // ══════════════════════════════════════════════════════════════

    function resolveRound(uint256 roundId, uint256[2] calldata signature) external nonReentrant {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalStakers > 0, "Use skipEmptyRound");

        beacon.verifyBeaconRound(round.drandRound, signature);
        bytes32 vrf = keccak256(abi.encodePacked(signature[0], signature[1]));

        // ─── Winner cell drawn STAKE-WEIGHTED: P(cell) = cellTotal/pool.
        //     Combined with the pro-rata split inside the cell, every wei
        //     staked has identical expected value regardless of which cell
        //     it sits on — so seeding dust across empty cells cannot dilute
        //     anyone else's odds (uniform-over-occupied was exploitable).
        uint256 target = uint256(vrf) % round.totalStaked;
        uint8 winningCell;
        uint256 acc;
        for (uint8 i = 0; i < 25; i++) {
            acc += cellTotal[roundId][i];
            if (target < acc) {
                winningCell = i;
                break;
            }
        }
        bool isBonus = (uint256(keccak256(abi.encodePacked(vrf, "bonus"))) % bonusRoundOdds) == 0;

        // ─── Money math ───
        uint256 pool = round.totalStaked;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 toReserve = (fee * bonusReserveBps) / BPS_BASE;
        accumulatedFees += fee - toReserve;
        bonusReserve += toReserve;

        uint256 afterFee = pool - fee;
        // Tip is capped proportionally so it can never eat the prize on
        // small pots, whatever resolverTipWei is configured to
        uint256 tipCap = afterFee / 10;
        uint256 tipPaid = resolverTipWei < tipCap ? resolverTipWei : tipCap;
        uint256 distributable = afterFee - tipPaid;

        if (isBonus) {
            // Bonus multiplier paid EXCLUSIVELY from the self-funded reserve,
            // and only declared when the reserve can pay it IN FULL — so a
            // round flagged Motherlode always really pays the full multiple
            uint256 extra = distributable * (bonusMultiplier - 1);
            if (extra <= bonusReserve) {
                bonusReserve -= extra;
                distributable += extra;
            } else {
                isBonus = false;
            }
        }

        uint256 winnerTotal = cellTotal[roundId][winningCell];
        uint256 griddyBase = isBonus ? motherlodePerRound : griddyPerRound;

        round.winningCell = winningCell;
        round.resolved = true;
        round.isBonusRound = isBonus;
        round.winnerTotal = winnerTotal;
        round.distributable = distributable;
        round.griddyBase = griddyBase;

        // ─── Pro-rata auto-pay (bounded by MAX_STAKERS_PER_CELL) ───
        address[] storage winners = cellStakers[roundId][winningCell];
        uint256 winnersCount = winners.length;
        uint256 paidTotal;
        for (uint256 i = 0; i < winnersCount; i++) {
            paidTotal += _payWinner(roundId, winners[i], winningCell, winnerTotal, distributable, griddyBase);
        }
        // ETH rounding dust is banked in the tracked Motherlode reserve so the
        // contract never accrues untracked wei
        bonusReserve += distributable - paidTotal;

        if (tipPaid > 0) {
            (bool tipOk, ) = msg.sender.call{value: tipPaid, gas: PUSH_GAS}("");
            if (!tipOk) {
                unclaimedWinnings[msg.sender] += tipPaid;
                pendingWithdrawals += tipPaid;
                emit WinningsEscrowed(roundId, msg.sender, tipPaid);
            }
            emit ResolverTipPaid(roundId, msg.sender, tipPaid);
        }

        emit RoundResolved(roundId, winningCell, winnersCount, winnerTotal, distributable, isBonus);
        _startNewRound();
    }

    function _payWinner(
        uint256 roundId,
        address w,
        uint8 winningCell,
        uint256 winnerTotal,
        uint256 distributable,
        uint256 griddyBase
    ) private returns (uint256 ethOut) {
        uint256 s = stakeOf[roundId][winningCell][w];
        ethOut = Math.mulDiv(distributable, s, winnerTotal);
        uint256 griddyOut = Math.mulDiv(griddyBase, s, winnerTotal);

        if (ethOut > 0) {
            (bool ok, ) = w.call{value: ethOut, gas: PUSH_GAS}("");
            if (!ok) {
                unclaimedWinnings[w] += ethOut;
                pendingWithdrawals += ethOut;
                emit WinningsEscrowed(roundId, w, ethOut);
            }
        }
        if (griddyOut > 0) {
            try griddyToken.mint(w, griddyOut) {} catch {
                emit RewardMintFailed(roundId, w, griddyOut);
            }
        }
        emit WinningsPaid(roundId, w, ethOut, griddyOut);
    }

    /// @notice Pull escape hatch for winners whose push transfer failed.
    function withdrawWinnings() external nonReentrant {
        uint256 amount = unclaimedWinnings[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        unclaimedWinnings[msg.sender] = 0;
        pendingWithdrawals -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH send failed");
        emit WinningsWithdrawn(msg.sender, amount);
    }

    /// @notice Skip an ended round with no stakers. Permissionless.
    function skipEmptyRound(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");
        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalStakers == 0, "Has stakers");
        round.resolved = true;
        emit EmptyRoundSkipped(currentRoundId);
        _startNewRound();
    }

    /// @notice Re-pin an overdue round to a fresh future beacon. Owner-only
    ///         and strictly forward-moving; the permissionless liveness path
    ///         is requestVoid/voidStuckRound, which refunds rather than re-draws.
    function repinRound(uint256 roundId) external onlyOwner {
        require(roundId == currentRoundId, "Wrong round");
        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        require(round.totalStakers > 0, "Use skipEmptyRound");
        require(block.timestamp > beacon.timeOfRound(round.drandRound) + REPIN_TIMEOUT, "Beacon not overdue");
        uint64 newDrandRound = beacon.roundAt(block.timestamp + beaconGap);
        require(newDrandRound > round.drandRound, "Not forward");
        emit RoundRepinned(roundId, round.drandRound, newDrandRound);
        round.drandRound = newDrandRound;
    }

    /// @notice Seed the Motherlode reserve with ETH. Anyone can fatten the pot.
    function depositBonusReserve() external payable nonReentrant {
        require(msg.value > 0, "Zero amount");
        bonusReserve += msg.value;
        emit BonusReserveDeposited(msg.sender, msg.value);
    }

    // ══════════════════════════════════════════════════════════════
    // Liveness backstop — only matters if drand itself disappears
    // ══════════════════════════════════════════════════════════════

    function requestVoid(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");
        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        require(round.totalStakers > 0, "Use skipEmptyRound");
        require(block.timestamp > uint256(round.endTime) + REFUND_DELAY, "Not stuck");
        require(voidRequestedAt[roundId] == 0, "Already requested");
        voidRequestedAt[roundId] = uint64(block.timestamp);
        emit VoidRequested(roundId, uint64(block.timestamp + VOID_GRACE));
    }

    function voidStuckRound(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");
        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        uint64 requestedAt = voidRequestedAt[roundId];
        require(requestedAt != 0, "Void not requested");
        require(block.timestamp > uint256(requestedAt) + VOID_GRACE, "Grace not over");
        round.resolved = true;
        roundVoided[currentRoundId] = true;
        pendingRefunds += round.totalStaked;
        paused = true;
        emit PausedSet(true);
        emit RoundVoided(currentRoundId);
        _startNewRound();
    }

    /// @notice Reclaim exactly what you staked (across all cells) in a voided round.
    function refund(uint256 roundId) external nonReentrant {
        require(roundVoided[roundId], "Not voided");
        uint256 amount = playerTotalStaked[roundId][msg.sender];
        require(amount > 0, "Not entered");
        require(!refunded[roundId][msg.sender], "Already refunded");
        refunded[roundId][msg.sender] = true;
        pendingRefunds -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH send failed");
        emit Refunded(roundId, msg.sender, amount);
    }

    // ══════════════════════════════════════════════════════════════
    // Views
    // ══════════════════════════════════════════════════════════════

    function getCellTotals(uint256 roundId) external view returns (uint256[25] memory totals) {
        for (uint8 i = 0; i < GRID_SIZE; i++) totals[i] = cellTotal[roundId][i];
    }

    function getCellStakerCounts(uint256 roundId) external view returns (uint256[25] memory counts) {
        for (uint8 i = 0; i < GRID_SIZE; i++) counts[i] = cellStakers[roundId][i].length;
    }

    function getCellStakers(uint256 roundId, uint8 cell) external view returns (address[] memory) {
        return cellStakers[roundId][cell];
    }

    function getPlayerStakes(uint256 roundId, address player) external view returns (uint256[25] memory stakes) {
        for (uint8 i = 0; i < GRID_SIZE; i++) stakes[i] = stakeOf[roundId][i][player];
    }

    function hasJoined(uint256 roundId, address player) external view returns (bool) {
        return playerTotalStaked[roundId][player] > 0;
    }

    function isWinner(uint256 roundId, address player) external view returns (bool) {
        Round storage round = rounds[roundId];
        if (!round.resolved || roundVoided[roundId]) return false;
        return stakeOf[roundId][round.winningCell][player] > 0;
    }

    function getCurrentRound() external view returns (
        uint256 roundId,
        uint64 startTime,
        uint64 endTime,
        uint256 totalStaked,
        uint256 totalStakers,
        uint256 timeRemaining
    ) {
        Round storage round = rounds[currentRoundId];
        roundId = currentRoundId;
        startTime = round.startTime;
        endTime = round.endTime;
        totalStaked = round.totalStaked;
        totalStakers = round.totalStakers;
        timeRemaining = block.timestamp < round.endTime ? round.endTime - block.timestamp : 0;
    }

    /// @notice Expected (non-bonus) winnings for msg.sender if `cell` wins,
    ///         after adding `stakeToAdd` to it. Mirrors resolve math exactly.
    function getExpectedPayout(uint8 cell, uint256 stakeToAdd) external view returns (uint256 ethIfWin, uint256 griddyIfWin) {
        require(cell < GRID_SIZE, "Invalid cell");
        uint256 roundId = currentRoundId;
        uint256 pool = rounds[roundId].totalStaked + stakeToAdd;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 afterFee = pool - fee;
        uint256 tipCap = afterFee / 10;
        uint256 tip = resolverTipWei < tipCap ? resolverTipWei : tipCap;
        uint256 dist = afterFee - tip;
        uint256 mine = stakeOf[roundId][cell][msg.sender] + stakeToAdd;
        uint256 cellTot = cellTotal[roundId][cell] + stakeToAdd;
        if (cellTot == 0 || mine == 0) return (0, 0);
        ethIfWin = Math.mulDiv(dist, mine, cellTot);
        griddyIfWin = Math.mulDiv(griddyPerRound, mine, cellTot);
    }

    // ══════════════════════════════════════════════════════════════
    // Internal
    // ══════════════════════════════════════════════════════════════

    function _startNewRound() internal {
        currentRoundId++;
        uint64 start = uint64(block.timestamp);
        uint64 drandRound = beacon.roundAt(start + uint64(roundDuration) + uint64(beaconGap));
        uint64 end = uint64(beacon.timeOfRound(drandRound)) - uint64(beaconGap);

        Round storage round = rounds[currentRoundId];
        round.startTime = start;
        round.endTime = end;
        round.drandRound = drandRound;

        emit RoundStarted(currentRoundId, start, end, drandRound);
    }

    // ══════════════════════════════════════════════════════════════
    // Admin
    // ══════════════════════════════════════════════════════════════

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Permanently disabled: the owner is the only path to
    ///         withdrawFees, setBeacon, repinRound and upgrades.
    function renounceOwnership() public pure override {
        revert("Renounce disabled");
    }

    function setPaused(bool _v) external onlyOwner { paused = _v; emit PausedSet(_v); }
    function setFeeRecipient(address _v) external onlyOwner { require(_v != address(0), "Zero address"); feeRecipient = _v; emit FeeRecipientUpdated(_v); }
    function setGriddyToken(address _v) external onlyOwner { require(_v != address(0), "Zero address"); griddyToken = IGriddyToken(_v); emit GriddyTokenUpdated(_v); }
    function setBeacon(address _v) external onlyOwner { require(_v != address(0), "Zero address"); emit BeaconUpdated(address(beacon), _v); beacon = DrandBeacon(_v); }
    function setMinStake(uint256 _v) external onlyOwner { require(_v >= MIN_STAKE_LO && _v <= MIN_STAKE_HI, "Out of bounds"); minStakeWei = _v; emit ConfigUpdated("minStakeWei", _v); }
    function setRoundDuration(uint256 _v) external onlyOwner { require(_v >= 10 && _v <= 3600, "10s-1h"); roundDuration = _v; emit ConfigUpdated("roundDuration", _v); }
    function setBeaconGap(uint256 _v) external onlyOwner { require(_v >= 8 && _v <= 60, "8-60s"); beaconGap = _v; emit ConfigUpdated("beaconGap", _v); }
    function setResolverTip(uint256 _v) external onlyOwner { require(_v <= MAX_RESOLVER_TIP, "Tip>0.001"); resolverTipWei = _v; emit ConfigUpdated("resolverTipWei", _v); }
    function setProtocolFeeBps(uint256 _v) external onlyOwner { require(_v <= 2000, "Fee>20%"); protocolFeeBps = _v; emit ConfigUpdated("protocolFeeBps", _v); }
    function setGriddyPerRound(uint256 _v) external onlyOwner { griddyPerRound = _v; emit ConfigUpdated("griddyPerRound", _v); }
    function setMotherlodePerRound(uint256 _v) external onlyOwner { motherlodePerRound = _v; emit ConfigUpdated("motherlodePerRound", _v); }
    function setBonusRoundOdds(uint256 _v) external onlyOwner { require(_v >= 10, "Too frequent"); bonusRoundOdds = _v; emit ConfigUpdated("bonusRoundOdds", _v); }
    function setBonusMultiplier(uint256 _v) external onlyOwner { require(_v >= 1 && _v <= 100, "1-100x"); bonusMultiplier = _v; emit ConfigUpdated("bonusMultiplier", _v); }
    function setBonusReserveBps(uint256 _v) external onlyOwner { require(_v <= BPS_BASE, ">100%"); bonusReserveBps = _v; emit ConfigUpdated("bonusReserveBps", _v); }

    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        (bool ok, ) = feeRecipient.call{value: amount}("");
        require(ok, "ETH send failed");
    }

    /// @notice Sweep only funds owed to nobody. The owner can NEVER touch
    ///         player stakes, refunds, escrowed winnings, the bonus reserve,
    ///         or unclaimed fees.
    function sweepSurplus() external onlyOwner {
        uint256 reservedFunds = rounds[currentRoundId].totalStaked
            + pendingRefunds
            + pendingWithdrawals
            + bonusReserve
            + accumulatedFees;
        uint256 bal = address(this).balance;
        require(bal > reservedFunds, "No surplus");
        (bool ok, ) = owner().call{value: bal - reservedFunds}("");
        require(ok, "ETH send failed");
    }

    /// @dev Strays land as sweepable surplus.
    receive() external payable {}
}
