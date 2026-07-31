// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DrandBeacon} from "./drand/DrandBeacon.sol";

interface IGriddyToken {
    function mint(address to, uint256 amount) external;
}

/// @title Griddy — drand-powered 5x5 grid game
/// @notice 5x5 grid, USDG entry, drand beacon picks from OCCUPIED cells,
///         winnings sent automatically on resolve.
/// @dev Grid game with the winning cell drawn from a drand beacon via
///      on-chain verification of drand evmnet beacon signatures (BN254).
///      Every round pins the drand round number whose beacon is emitted
///      strictly AFTER entries close, so the randomness cannot exist while
///      betting is open, and resolution is permissionless: anyone holding
///      the public beacon signature can resolve and earn the resolver tip.
contract Griddy is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant GRID_SIZE = 25;
    uint256 public constant BPS_BASE = 10_000;
    /// @notice If a round is still unresolved this long after it ended
    ///         (drand dead AND nobody resolved), it can be voided and
    ///         players refunded. Beacons are unchained, so any past round
    ///         stays resolvable forever under normal operation.
    uint256 public constant REFUND_DELAY = 30 days;
    /// @notice Voiding is two-step (request, then execute after this grace
    ///         period) so a still-obtainable beacon always wins the race
    ///         against a player trying to void away a known loss.
    uint256 public constant VOID_GRACE = 3 days;
    /// @notice Bounds the auto-pay loop in resolveRound so a flooded cell can
    ///         never make resolution exceed the block gas limit (~9M gas at
    ///         the cap vs Arbitrum's 32M tx limit).
    uint256 public constant MAX_PER_CELL = 100;
    /// @notice Seconds between entry close and the pinned beacon's emission.
    ///         Rounds are aligned to the drand grid so this gap is EXACT every
    ///         round: resolution lands ~beaconGap+1s after entries close,
    ///         while the beacon still provably doesn't exist during betting
    ///         (protects against sequencer clock lag up to beaconGap seconds).
    uint256 public beaconGap = 2;
    /// @notice If the pinned beacon hasn't been submitted this long after its
    ///         emission time, anyone can re-pin the round to a fresh future
    ///         beacon — the game self-heals from a drand hiccup in minutes,
    ///         with the 30-day void/refund path as the nuclear backstop.
    uint256 public constant REPIN_TIMEOUT = 5 minutes;

    IERC20 public immutable usdg;
    DrandBeacon public immutable beacon;
    IGriddyToken public griddyToken;

    address public feeRecipient;

    uint256 public entryFee = 1e6;              // 1 USDG (6 decimals)
    uint256 public roundDuration = 30;           // 30s
    uint256 public protocolFeeBps = 500;         // 5%
    uint256 public resolverReward = 0.1e6;       // 0.1 USDG

    uint256 public griddyPerRound = 100e18;
    uint256 public motherlodePerRound = 1000e18;
    uint256 public bonusRoundOdds = 100;
    uint256 public bonusMultiplier = 10;

    uint256 public currentRoundId;
    uint256 public accumulatedFees;
    /// @notice USDG owed to players of voided rounds — reserved and never
    ///         spendable by payouts, bonus caps, or the resolver tip.
    uint256 public pendingRefunds;
    /// @notice Self-funding Motherlode pot: a share of every protocol fee
    ///         accrues here, and bonus rounds pay their extra multiplier
    ///         exclusively from it — 10x is real once the reserve builds,
    ///         and no other funds can ever be raided for it.
    uint256 public bonusReserve;
    /// @notice Share of the protocol fee diverted to the bonus reserve (bps)
    uint256 public bonusReserveBps = 5000;
    /// @notice Set automatically when a round is voided (drand presumed
    ///         dead); owner resumes once the beacon is confirmed live again.
    bool public paused;

    struct Round {
        uint64 startTime;
        uint64 endTime;
        uint256 totalDeposits;
        uint256 totalPlayers;
        uint8 winningCell;
        bool resolved;
        bool isBonusRound;
        uint64 drandRound;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(uint8 => address[])) public cellPlayers;
    mapping(uint256 => mapping(address => uint8)) public playerCell;

    // Track per-round payouts for transparency
    mapping(uint256 => uint256) public roundUsdcPerWinner;
    mapping(uint256 => uint256) public roundZeroPerWinner;

    // Liveness backstop
    mapping(uint256 => bool) public roundVoided;
    mapping(uint256 => mapping(address => bool)) public refunded;
    mapping(uint256 => uint64) public voidRequestedAt;
    // Exact amount each player paid in, so refunds are precise even if the
    // owner changes entryFee mid-round
    mapping(uint256 => mapping(address => uint256)) public paidAmount;

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime, uint64 drandRound);
    event CellPicked(uint256 indexed roundId, address indexed player, uint8 cell);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, bool isBonusRound);
    event WinningsPaid(uint256 indexed roundId, address indexed player, uint256 usdcAmount, uint256 zeroAmount);
    event RewardMintFailed(uint256 indexed roundId, address indexed player, uint256 zeroAmount);
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

    constructor(
        address _usdg,
        address _griddyToken,
        address _feeRecipient,
        address _beacon
    ) Ownable(msg.sender) {
        require(_usdg != address(0) && _beacon != address(0), "Zero address");
        usdg = IERC20(_usdg);
        griddyToken = IGriddyToken(_griddyToken);
        feeRecipient = _feeRecipient;
        beacon = DrandBeacon(_beacon);
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // Player Actions
    // ══════════════════════════════════════════════════════════════

    function pickCell(uint8 cell) external nonReentrant {
        require(cell < GRID_SIZE, "Invalid cell");
        require(!paused, "Paused");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp < round.endTime, "Round ended");
        require(playerCell[currentRoundId][msg.sender] == 0, "Already entered");
        require(cellPlayers[currentRoundId][cell].length < MAX_PER_CELL, "Cell full");

        usdg.safeTransferFrom(msg.sender, address(this), entryFee);

        playerCell[currentRoundId][msg.sender] = cell + 1;
        cellPlayers[currentRoundId][cell].push(msg.sender);
        paidAmount[currentRoundId][msg.sender] = entryFee;

        round.totalDeposits += entryFee;
        round.totalPlayers++;

        emit CellPicked(currentRoundId, msg.sender, cell);
    }

    // ══════════════════════════════════════════════════════════════
    // Resolution — permissionless, drand-beacon verified, auto-pay
    // ══════════════════════════════════════════════════════════════

    /// @notice Resolve the current round with the drand beacon signature for
    ///         the round's pinned drand round. Anyone can call; the caller
    ///         earns `resolverReward`.
    /// @param roundId Round to resolve (must be the current round)
    /// @param signature drand evmnet BLS signature for `rounds[roundId].drandRound`,
    ///        as the uncompressed G1 point (x, y)
    function resolveRound(uint256 roundId, uint256[2] calldata signature) external nonReentrant {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");

        // Reverts if the signature is not the beacon's unique signature for
        // this drand round — nobody, including the caller, can bias it.
        beacon.verifyBeaconRound(round.drandRound, signature);
        bytes32 vrfOutput = keccak256(abi.encodePacked(signature[0], signature[1]));

        // ─── Pick winner from occupied cells ───
        uint8[25] memory occupied;
        uint256 occupiedCount = 0;
        for (uint8 i = 0; i < 25; i++) {
            if (cellPlayers[currentRoundId][i].length > 0) {
                occupied[occupiedCount] = i;
                occupiedCount++;
            }
        }

        uint256 randomIndex = uint256(vrfOutput) % occupiedCount;
        uint8 winningCell = occupied[randomIndex];

        bool isBonus = (uint256(keccak256(abi.encodePacked(vrfOutput, "bonus"))) % bonusRoundOdds) == 0;

        round.winningCell = winningCell;
        round.resolved = true;
        round.isBonusRound = isBonus;

        address[] storage winners = cellPlayers[currentRoundId][winningCell];
        uint256 winnersCount = winners.length;

        // ─── Calculate payouts ───
        uint256 pool = round.totalDeposits;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 toReserve = (fee * bonusReserveBps) / BPS_BASE;
        accumulatedFees += fee - toReserve;
        bonusReserve += toReserve;

        uint256 resolverCut = resolverReward;
        uint256 distributable;
        if (pool > fee + resolverCut) {
            distributable = pool - fee - resolverCut;
        } else {
            distributable = 0;
        }

        if (isBonus) {
            // The bonus multiplier is paid EXCLUSIVELY from the self-funded
            // reserve — solvent by construction, no other funds touchable
            uint256 extra = distributable * (bonusMultiplier - 1);
            if (extra > bonusReserve) extra = bonusReserve;
            bonusReserve -= extra;
            distributable += extra;
        }

        uint256 usdcPerWinner = winnersCount > 0 ? distributable / winnersCount : 0;
        uint256 zeroBase = isBonus ? motherlodePerRound : griddyPerRound;
        uint256 zeroPerWinner = winnersCount > 0 ? zeroBase / winnersCount : 0;

        // Store for transparency / frontend reads
        roundUsdcPerWinner[currentRoundId] = usdcPerWinner;
        roundZeroPerWinner[currentRoundId] = zeroPerWinner;

        // ─── AUTO-PAY all winners ───
        for (uint256 i = 0; i < winnersCount; i++) {
            address winner = winners[i];

            if (usdcPerWinner > 0) {
                usdg.safeTransfer(winner, usdcPerWinner);
            }
            if (zeroPerWinner > 0) {
                // A misbehaving reward token must never block USDG payouts
                try griddyToken.mint(winner, zeroPerWinner) {} catch {
                    emit RewardMintFailed(currentRoundId, winner, zeroPerWinner);
                }
            }

            emit WinningsPaid(currentRoundId, winner, usdcPerWinner, zeroPerWinner);
        }

        // Pay resolver
        if (resolverCut > 0 && usdg.balanceOf(address(this)) >= resolverCut) {
            usdg.safeTransfer(msg.sender, resolverCut);
        }

        emit RoundResolved(currentRoundId, winningCell, winnersCount, isBonus);
        _startNewRound();
    }

    /// @notice Re-pin a round whose beacon has been unobtainable for
    ///         REPIN_TIMEOUT to a fresh future beacon. Permissionless and
    ///         strictly forward-moving — a re-pin can never reach a beacon
    ///         that existed while betting was open.
    function repinRound(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");
        require(
            block.timestamp > beacon.timeOfRound(round.drandRound) + REPIN_TIMEOUT,
            "Beacon not overdue"
        );

        uint64 newDrandRound = beacon.roundAt(block.timestamp + beaconGap);
        require(newDrandRound > round.drandRound, "Not forward");
        emit RoundRepinned(roundId, round.drandRound, newDrandRound);
        round.drandRound = newDrandRound;
    }

    /// @notice Seed the Motherlode reserve. Anyone can fatten the pot.
    function depositBonusReserve(uint256 amount) external nonReentrant {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        bonusReserve += amount;
        emit BonusReserveDeposited(msg.sender, amount);
    }

    /// @notice Skip an ended round with no players. Permissionless.
    function skipEmptyRound(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers == 0, "Has players");

        round.resolved = true;
        emit EmptyRoundSkipped(currentRoundId);
        _startNewRound();
    }

    // ══════════════════════════════════════════════════════════════
    // Liveness backstop — only matters if drand itself disappears
    // ══════════════════════════════════════════════════════════════

    /// @notice Step 1: flag a round that has sat unresolved for REFUND_DELAY
    ///         after it ended. Permissionless. resolveRound stays open during
    ///         the grace window, so if the beacon exists it always wins.
    function requestVoid(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        require(round.totalPlayers > 0, "Use skipEmptyRound");
        require(block.timestamp > uint256(round.endTime) + REFUND_DELAY, "Not stuck");
        require(voidRequestedAt[roundId] == 0, "Already requested");

        voidRequestedAt[roundId] = uint64(block.timestamp);
        emit VoidRequested(roundId, uint64(block.timestamp + VOID_GRACE));
    }

    /// @notice Step 2: after the grace window, void the round, unfreeze the
    ///         game (paused until owner resumes), and open refunds.
    function voidStuckRound(uint256 roundId) external {
        require(roundId == currentRoundId, "Wrong round");

        Round storage round = rounds[currentRoundId];
        require(!round.resolved, "Already resolved");
        uint64 requestedAt = voidRequestedAt[roundId];
        require(requestedAt != 0, "Void not requested");
        require(block.timestamp > uint256(requestedAt) + VOID_GRACE, "Grace not over");

        round.resolved = true;
        roundVoided[currentRoundId] = true;
        pendingRefunds += round.totalDeposits;
        // drand is presumed dead — stop taking deposits until the owner
        // confirms the beacon is live again
        paused = true;
        emit PausedSet(true);
        emit RoundVoided(currentRoundId);
        _startNewRound();
    }

    /// @notice Reclaim exactly what you paid into a voided round.
    function refund(uint256 roundId) external nonReentrant {
        require(roundVoided[roundId], "Not voided");
        require(playerCell[roundId][msg.sender] != 0, "Not entered");
        require(!refunded[roundId][msg.sender], "Already refunded");

        refunded[roundId][msg.sender] = true;
        uint256 amount = paidAmount[roundId][msg.sender];
        pendingRefunds -= amount;
        usdg.safeTransfer(msg.sender, amount);
        emit Refunded(roundId, msg.sender, amount);
    }

    // ══════════════════════════════════════════════════════════════
    // View Helpers
    // ══════════════════════════════════════════════════════════════

    function getCellCounts(uint256 roundId) external view returns (uint256[25] memory counts) {
        for (uint8 i = 0; i < GRID_SIZE; i++) {
            counts[i] = cellPlayers[roundId][i].length;
        }
    }

    function getCellPlayers(uint256 roundId, uint8 cell) external view returns (address[] memory) {
        return cellPlayers[roundId][cell];
    }

    function isWinner(uint256 roundId, address player) external view returns (bool) {
        Round storage round = rounds[roundId];
        if (!round.resolved || roundVoided[roundId]) return false;
        uint8 picked = playerCell[roundId][player];
        if (picked == 0) return false;
        return (picked - 1) == round.winningCell;
    }

    function hasJoined(uint256 roundId, address player) external view returns (bool) {
        return playerCell[roundId][player] != 0;
    }

    function getCurrentRound() external view returns (
        uint256 roundId,
        uint64 startTime,
        uint64 endTime,
        uint256 totalDeposits,
        uint256 totalPlayers,
        uint256 timeRemaining
    ) {
        Round storage round = rounds[currentRoundId];
        roundId = currentRoundId;
        startTime = round.startTime;
        endTime = round.endTime;
        totalDeposits = round.totalDeposits;
        totalPlayers = round.totalPlayers;
        timeRemaining = block.timestamp < round.endTime
            ? round.endTime - block.timestamp
            : 0;
    }

    function getPotentialPayout(uint8 cell) external view returns (uint256 usdcPayout, uint256 zeroPayout) {
        Round storage round = rounds[currentRoundId];
        uint256 pool = round.totalDeposits + entryFee;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 deductions = fee + resolverReward;
        uint256 distributable = pool > deductions ? pool - deductions : 0;
        uint256 winnersOnCell = cellPlayers[currentRoundId][cell].length + 1;
        usdcPayout = distributable / winnersOnCell;
        zeroPayout = griddyPerRound / winnersOnCell;
    }

    // ══════════════════════════════════════════════════════════════
    // Internal
    // ══════════════════════════════════════════════════════════════

    function _startNewRound() internal {
        currentRoundId++;
        uint64 start = uint64(block.timestamp);
        // Pin the first beacon emitted at-or-after the nominal round end plus
        // the safety gap, then align the actual entry close to land exactly
        // `beaconGap` seconds before that beacon: fast AND provably unknowable
        // while betting is open. Actual duration = roundDuration + 0..period.
        uint64 drandRound = beacon.roundAt(start + uint64(roundDuration) + uint64(beaconGap));
        uint64 end = uint64(beacon.timeOfRound(drandRound)) - uint64(beaconGap);

        rounds[currentRoundId] = Round({
            startTime: start,
            endTime: end,
            totalDeposits: 0,
            totalPlayers: 0,
            winningCell: 0,
            resolved: false,
            isBonusRound: false,
            drandRound: drandRound
        });

        emit RoundStarted(currentRoundId, start, end, drandRound);
    }

    // ══════════════════════════════════════════════════════════════
    // Admin
    // ══════════════════════════════════════════════════════════════

    function setPaused(bool _v) external onlyOwner { paused = _v; emit PausedSet(_v); }
    function setFeeRecipient(address _v) external onlyOwner { require(_v != address(0), "Zero address"); feeRecipient = _v; emit FeeRecipientUpdated(_v); }
    function setGriddyToken(address _v) external onlyOwner { require(_v != address(0), "Zero address"); griddyToken = IGriddyToken(_v); emit GriddyTokenUpdated(_v); }
    function setEntryFee(uint256 _v) external onlyOwner { entryFee = _v; emit ConfigUpdated("entryFee", _v); }
    function setRoundDuration(uint256 _v) external onlyOwner { roundDuration = _v; emit ConfigUpdated("roundDuration", _v); }
    function setBeaconGap(uint256 _v) external onlyOwner { require(_v >= 1 && _v <= 60, "1-60s"); beaconGap = _v; emit ConfigUpdated("beaconGap", _v); }
    function setGriddyPerRound(uint256 _v) external onlyOwner { griddyPerRound = _v; emit ConfigUpdated("griddyPerRound", _v); }
    function setProtocolFeeBps(uint256 _v) external onlyOwner { require(_v <= 2000, "Fee>20%"); protocolFeeBps = _v; emit ConfigUpdated("protocolFeeBps", _v); }
    function setResolverReward(uint256 _v) external onlyOwner { resolverReward = _v; emit ConfigUpdated("resolverReward", _v); }
    function setMotherlodePerRound(uint256 _v) external onlyOwner { motherlodePerRound = _v; emit ConfigUpdated("motherlodePerRound", _v); }
    function setBonusRoundOdds(uint256 _v) external onlyOwner { require(_v >= 10, "Too frequent"); bonusRoundOdds = _v; emit ConfigUpdated("bonusRoundOdds", _v); }
    function setBonusMultiplier(uint256 _v) external onlyOwner { require(_v >= 1 && _v <= 100, "1-100x"); bonusMultiplier = _v; emit ConfigUpdated("bonusMultiplier", _v); }
    function setBonusReserveBps(uint256 _v) external onlyOwner { require(_v <= BPS_BASE, ">100%"); bonusReserveBps = _v; emit ConfigUpdated("bonusReserveBps", _v); }

    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        usdg.safeTransfer(feeRecipient, amount);
    }

    /// @notice Sweep only funds owed to nobody: balance minus the live
    ///         round's escrow, refund escrow, bonus reserve, and unclaimed
    ///         fees. The owner can recover strays/donations but can NEVER
    ///         touch player money (replaces the V4 full-balance sweep).
    function sweepSurplus() external onlyOwner {
        uint256 reservedFunds = rounds[currentRoundId].totalDeposits
            + pendingRefunds
            + bonusReserve
            + accumulatedFees;
        uint256 bal = usdg.balanceOf(address(this));
        require(bal > reservedFunds, "No surplus");
        usdg.safeTransfer(owner(), bal - reservedFunds);
    }
}
