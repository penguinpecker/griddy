// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DrandBeacon} from "./drand/DrandBeacon.sol";

/// @title GriddyV7 — variable-stake native-token pari-mutuel 5x5 grid, grid-aligned rounds
/// @notice Players stake any amount of ETH (>= minStakeWei per new position) on
///         any cells. A drand evmnet beacon — pinned at round start to a round
///         emitted only after betting closes, BLS-verified on-chain — picks the
///         winning cell weighted by stake. Winners split the prize pro-rata to
///         their stake on that cell, so every wei has identical expected value
///         wherever it sits. Players receive exactly (1 - protocolFeeBps) of
///         every pot: the resolver tip is paid OUT OF the protocol fee, never
///         on top of it. V5 decouples betting from resolution: the betting
///         round rolls lazily on the first stake after the previous window
///         closes, resolution of any ended round is independent and
///         permissionless, and empty rounds simply expire with zero gas
///         (skipEmptyRound is kept only as optional hygiene). No bonus rounds,
///         no reward token. V6 raises MIN_STAKE_HI — the ceiling setMinStake
///         may set — from 1e16 to 1e18, so the owner can price a new position
///         at up to $1 on a USDC-gas chain. V7 anchors round boundaries to a
///         fixed grid — roundEpoch + k * roundDuration — instead of to the
///         moment somebody staked, so the clock keeps running with zero
///         players: {currentWindow} reports the live window straight from
///         block.timestamp with no round materialised, and rounds still cost
///         nothing until the first stake writes one. Fee/tip/payout math,
///         continuous resolution and every accounting invariant are unchanged
///         from V6. UUPS-upgradeable (storage layout frozen from V2: retired
///         vars retained, unused; V7 appends roundEpoch at the end).
contract GriddyV7 is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// @dev Namespaced-slot reentrancy guard (OZ 5.6 dropped the storage-based
    ///      upgradeable guard; transient storage isn't guaranteed on all chains)
    bytes32 private constant REENTRANCY_SLOT = keccak256("griddy.v2.reentrancy");  // unchanged: same proxy

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
    uint256 public constant MIN_STAKE_HI = 1e18;
    uint256 public constant MAX_RESOLVER_TIP = 1e15;
    /// @notice Gas forwarded on winner/tip pushes; failures escrow to pull
    uint256 public constant PUSH_GAS = 40_000;
    /// @notice Shortest betting window a fresh round may open with. A stake
    ///         landing in the last few seconds of a grid window opens the NEXT
    ///         window instead, so nobody ever buys into a one-second round.
    uint256 public constant MIN_BET_WINDOW = 6;

    // ─── Linear storage: NEVER reorder, append-only (see __gap) ───
    /// @custom:oz-renamed-from griddyToken
    address public griddyToken_retired;
    DrandBeacon public beacon;
    address public feeRecipient;
    uint256 public minStakeWei;
    uint256 public roundDuration;
    uint256 public beaconGap;
    uint256 public protocolFeeBps;
    uint256 public resolverTipWei;
    // ─ retired in V3 (kept: storage layout is append-only) ─
    /// @custom:oz-renamed-from griddyPerRound
    uint256 public griddyPerRound_retired;
    /// @custom:oz-renamed-from motherlodePerRound
    uint256 public motherlodePerRound_retired;
    /// @custom:oz-renamed-from bonusRoundOdds
    uint256 public bonusRoundOdds_retired;
    /// @custom:oz-renamed-from bonusMultiplier
    uint256 public bonusMultiplier_retired;
    /// @custom:oz-renamed-from bonusReserveBps
    uint256 public bonusReserveBps_retired;
    uint256 public currentRoundId;
    uint256 public accumulatedFees;
    uint256 public pendingRefunds;
    uint256 public pendingWithdrawals;
    /// @custom:oz-renamed-from bonusReserve
    uint256 public bonusReserve_retired;
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
        uint256 griddyBase; // retired in V3: always 0
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
    // ─ appended in V5 (after __gap: existing slots must never move) ─
    /// @notice Sum of totalStaked over every round that has stakers and is
    ///         neither resolved nor voided — the game's outstanding liability
    ///         to players across all pending rounds (see sweepSurplus)
    uint256 public totalUnresolvedStakes;
    // ─ appended in V7 (still append-only: nothing above ever moves) ─
    /// @notice Anchor of the round grid. Every betting window is
    ///         [roundEpoch + k * roundDuration, roundEpoch + (k+1) * roundDuration),
    ///         so boundaries are a function of TIME, never of who staked when.
    uint64 public roundEpoch;

    event RoundStarted(uint256 indexed roundId, uint64 startTime, uint64 endTime, uint64 drandRound);
    event Staked(uint256 indexed roundId, address indexed player, uint8 cell, uint256 amount, uint256 playerCellTotal, uint256 cellTotalAfter);
    event RoundResolved(uint256 indexed roundId, uint8 winningCell, uint256 winnersCount, uint256 winnerTotal, uint256 distributable);
    event WinningsPaid(uint256 indexed roundId, address indexed player, uint256 ethAmount);
    event WinningsEscrowed(uint256 indexed roundId, address indexed player, uint256 amount);
    event WinningsWithdrawn(address indexed player, uint256 amount);
    event ResolverTipPaid(uint256 indexed roundId, address indexed resolver, uint256 amount);
    event EmptyRoundSkipped(uint256 indexed roundId);
    event RoundRepinned(uint256 indexed roundId, uint64 oldDrandRound, uint64 newDrandRound);
    event VoidRequested(uint256 indexed roundId, uint64 executableAt);
    event RoundVoided(uint256 indexed roundId);
    event Refunded(uint256 indexed roundId, address indexed player, uint256 amount);
    event PausedSet(bool paused);
    event ConfigUpdated(string key, uint256 value);
    event FeeRecipientUpdated(address recipient);
    event BeaconUpdated(address oldBeacon, address newBeacon);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address feeRecipient_,
        address beacon_,
        address owner_
    ) external initializer {
        require(
            feeRecipient_ != address(0) && beacon_ != address(0) && owner_ != address(0),
            "Zero address"
        );
        __Ownable_init(owner_);
        __Ownable2Step_init();

        beacon = DrandBeacon(beacon_);
        feeRecipient = feeRecipient_;
        minStakeWei = 1e14;          // 0.0001 ETH
        roundDuration = 30;
        beaconGap = 10;
        protocolFeeBps = 500;        // 5%
        resolverTipWei = 3e13;       // 0.00003 ETH
        roundEpoch = uint64(block.timestamp);   // anchor the grid before the first window
        _startNewRound();
    }

    /// @notice V2 -> V3 migration: the Motherlode reserve no longer has a
    ///         payout path, so its balance is folded into withdrawable fees.
    function initializeV3() external reinitializer(2) {
        uint256 stranded = bonusReserve_retired;
        if (stranded > 0) {
            bonusReserve_retired = 0;
            accumulatedFees += stranded;
        }
    }

    /// @notice V4 -> V5 migration: seed the unresolved-stake accumulator from
    ///         the single round that can be in flight under V4 rules.
    /// @dev The totalUnresolvedStakes == 0 guard makes this a no-op wherever
    ///      V5 stake-accounting is already live: on a V4 proxy the appended
    ///      slot is untouched so the genuine migration always seeds, but on a
    ///      fresh V5 deployment this reinitializer is callable by anyone and
    ///      an unconditional overwrite would collapse the multi-round
    ///      accumulator to the current round's pot — exposing older pending
    ///      stakes to sweepSurplus and underflowing their resolution.
    function initializeV5() external reinitializer(3) {
        Round storage round = rounds[currentRoundId];
        if (
            totalUnresolvedStakes == 0 &&
            !round.resolved && !roundVoided[currentRoundId] && round.totalStakers > 0
        ) {
            totalUnresolvedStakes = round.totalStaked;
        }
        // else: nothing to seed (the freshly appended slot already holds 0)
    }

    /// @notice V6 -> V7 migration: anchor the round grid at the upgrade block.
    /// @dev The roundEpoch == 0 guard mirrors initializeV5's. On a V6 proxy the
    ///      appended slot is untouched so the genuine migration always anchors,
    ///      but on a fresh V7 deployment initialize() already anchored the grid
    ///      and reinitializer(4) is left unclaimed and callable by anyone — an
    ///      unconditional write would let a stranger re-anchor the grid and
    ///      shift the window out from under everybody mid-countdown.
    function initializeV7() external reinitializer(4) {
        if (roundEpoch == 0) {
            roundEpoch = uint64(block.timestamp);
        }
        // else: the grid is already anchored — never re-phase it here
    }

    // ══════════════════════════════════════════════════════════════
    // Staking
    // ══════════════════════════════════════════════════════════════

    /// @notice Stake ETH on one or more cells of the current round. New
    ///         positions must be >= minStakeWei; top-ups can be any amount.
    ///         If the current betting window has expired, the first stake
    ///         lazily rolls to a fresh round (clients predict the id as
    ///         now < endTime ? currentRoundId : currentRoundId + 1, and its
    ///         window as {currentWindow}).
    function stake(uint256 roundId, uint8[] calldata cells, uint256[] calldata amounts) external payable nonReentrant {
        require(!paused, "Paused");
        // Lazy roll: the expired round stays behind awaiting independent
        // resolution (or nothing at all, if it is empty).
        if (block.timestamp >= rounds[currentRoundId].endTime) {
            _startNewRound();
        }
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
        totalUnresolvedStakes += msg.value;
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

    /// @notice Resolve any ended round with stakers — including rounds the
    ///         betting window has long since rolled past. Never opens rounds.
    function resolveRound(uint256 roundId, uint256[2] calldata signature) external nonReentrant {
        require(roundId <= currentRoundId, "Wrong round");

        Round storage round = rounds[roundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalStakers > 0, "Use skipEmptyRound");
        require(!roundVoided[roundId], "Voided");

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

        // ─── Money math ───
        uint256 pool = round.totalStaked;
        // Players always receive exactly (1 - protocolFeeBps) of the pot.
        // The resolver tip is drawn FROM the protocol fee, never added on top,
        // so no configuration can push the players' share below 95%.
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 tipPaid = resolverTipWei < fee ? resolverTipWei : fee;
        accumulatedFees += fee - tipPaid;
        uint256 distributable = pool - fee;
        uint256 winnerTotal = cellTotal[roundId][winningCell];

        round.winningCell = winningCell;
        round.resolved = true;
        round.winnerTotal = winnerTotal;
        round.distributable = distributable;
        totalUnresolvedStakes -= round.totalStaked;

        // ─── Pro-rata auto-pay (bounded by MAX_STAKERS_PER_CELL) ───
        address[] storage winners = cellStakers[roundId][winningCell];
        uint256 winnersCount = winners.length;
        uint256 paidTotal;
        for (uint256 i = 0; i < winnersCount; i++) {
            paidTotal += _payWinner(roundId, winners[i], winningCell, winnerTotal, distributable);
        }
        // Rounding dust joins protocol fees so no wei is ever untracked
        accumulatedFees += distributable - paidTotal;

        if (tipPaid > 0) {
            (bool tipOk, ) = msg.sender.call{value: tipPaid, gas: PUSH_GAS}("");
            if (!tipOk) {
                unclaimedWinnings[msg.sender] += tipPaid;
                pendingWithdrawals += tipPaid;
                emit WinningsEscrowed(roundId, msg.sender, tipPaid);
            }
            emit ResolverTipPaid(roundId, msg.sender, tipPaid);
        }

        emit RoundResolved(roundId, winningCell, winnersCount, winnerTotal, distributable);
    }

    function _payWinner(
        uint256 roundId,
        address w,
        uint8 winningCell,
        uint256 winnerTotal,
        uint256 distributable
    ) private returns (uint256 ethOut) {
        uint256 s = stakeOf[roundId][winningCell][w];
        ethOut = Math.mulDiv(distributable, s, winnerTotal);

        if (ethOut > 0) {
            (bool ok, ) = w.call{value: ethOut, gas: PUSH_GAS}("");
            if (!ok) {
                unclaimedWinnings[w] += ethOut;
                pendingWithdrawals += ethOut;
                emit WinningsEscrowed(roundId, w, ethOut);
            }
        }
        emit WinningsPaid(roundId, w, ethOut);
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

    /// @notice Mark an ended round with no stakers as resolved. Permissionless.
    ///         Optional hygiene in V5: empty rounds are harmless if never
    ///         skipped — they simply expire with zero gas.
    function skipEmptyRound(uint256 roundId) external {
        require(roundId <= currentRoundId, "Wrong round");
        Round storage round = rounds[roundId];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.resolved, "Already resolved");
        require(round.totalStakers == 0, "Has stakers");
        round.resolved = true;
        emit EmptyRoundSkipped(roundId);
    }

    /// @notice Re-pin an overdue round to a fresh future beacon. Owner-only
    ///         and strictly forward-moving; the permissionless liveness path
    ///         is requestVoid/voidStuckRound, which refunds rather than re-draws.
    function repinRound(uint256 roundId) external onlyOwner {
        require(roundId <= currentRoundId, "Wrong round");
        Round storage round = rounds[roundId];
        require(!round.resolved, "Already resolved");
        require(round.totalStakers > 0, "Use skipEmptyRound");
        require(block.timestamp > beacon.timeOfRound(round.drandRound) + REPIN_TIMEOUT, "Beacon not overdue");
        uint64 newDrandRound = beacon.roundAt(block.timestamp + beaconGap);
        require(newDrandRound > round.drandRound, "Not forward");
        emit RoundRepinned(roundId, round.drandRound, newDrandRound);
        round.drandRound = newDrandRound;
    }

    // ══════════════════════════════════════════════════════════════
    // Liveness backstop — only matters if drand itself disappears
    // ══════════════════════════════════════════════════════════════

    function requestVoid(uint256 roundId) external {
        require(roundId <= currentRoundId, "Wrong round");
        Round storage round = rounds[roundId];
        require(!round.resolved, "Already resolved");
        require(round.totalStakers > 0, "Use skipEmptyRound");
        require(block.timestamp > uint256(round.endTime) + REFUND_DELAY, "Not stuck");
        require(voidRequestedAt[roundId] == 0, "Already requested");
        voidRequestedAt[roundId] = uint64(block.timestamp);
        emit VoidRequested(roundId, uint64(block.timestamp + VOID_GRACE));
    }

    function voidStuckRound(uint256 roundId) external {
        require(roundId <= currentRoundId, "Wrong round");
        Round storage round = rounds[roundId];
        require(!round.resolved, "Already resolved");
        uint64 requestedAt = voidRequestedAt[roundId];
        require(requestedAt != 0, "Void not requested");
        require(block.timestamp > uint256(requestedAt) + VOID_GRACE, "Grace not over");
        round.resolved = true;
        roundVoided[roundId] = true;
        totalUnresolvedStakes -= round.totalStaked;
        pendingRefunds += round.totalStaked;
        paused = true;
        emit PausedSet(true);
        emit RoundVoided(roundId);
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

    /// @notice The betting window a stake sent right now would land in —
    ///         derived purely from block.timestamp, roundEpoch, roundDuration
    ///         and beaconGap, with no round materialised on-chain.
    /// @dev This is what makes an empty lobby tick: with nobody playing there
    ///      is no Round to read, but the grid is still advancing, so a client
    ///      can render an honest countdown for free. It applies the same
    ///      MIN_BET_WINDOW roll-forward as _startNewRound, so the window shown
    ///      is exactly the window the next stake buys into — and that stake is
    ///      still the first thing that writes any storage.
    function currentWindow() external view returns (
        uint64 windowStart,
        uint64 windowEnd,
        uint64 drandRound,
        uint256 secondsLeft
    ) {
        // A stake only opens a NEW window when the current round has closed.
        // While a round is still live, a stake joins THAT round, so report its
        // window — otherwise this view would advertise a deadline the stake
        // does not actually get (they differ whenever the live round opened on
        // a MIN_BET_WINDOW roll-forward, or before a roundDuration change).
        Round storage live = rounds[currentRoundId];
        if (currentRoundId != 0 && !live.resolved && block.timestamp < live.endTime) {
            // Report the grid slot the live round closes on, so windowStart
            // stays a grid boundary, but with the round's own deadline and pin.
            (uint64 liveStart, ) = _windowOf(live.endTime - 1);
            return (
                liveStart,
                live.endTime,
                live.drandRound,
                uint256(live.endTime) - block.timestamp
            );
        }
        (windowStart, windowEnd) = _bettableWindow(uint64(block.timestamp));
        drandRound = beacon.roundAt(uint256(windowEnd) + beaconGap);
        secondsLeft = block.timestamp < windowEnd ? windowEnd - block.timestamp : 0;
    }

    /// @notice Expected winnings for msg.sender if `cell` wins, after adding
    ///         `stakeToAdd` to it. Mirrors resolve math exactly.
    function getExpectedPayout(uint8 cell, uint256 stakeToAdd) external view returns (uint256 ethIfWin) {
        require(cell < GRID_SIZE, "Invalid cell");
        uint256 roundId = currentRoundId;
        uint256 pool = rounds[roundId].totalStaked + stakeToAdd;
        uint256 fee = (pool * protocolFeeBps) / BPS_BASE;
        uint256 dist = pool - fee;   // tip comes out of the fee, not the prize
        uint256 mine = stakeOf[roundId][cell][msg.sender] + stakeToAdd;
        uint256 cellTot = cellTotal[roundId][cell] + stakeToAdd;
        if (cellTot == 0 || mine == 0) return 0;
        ethIfWin = Math.mulDiv(dist, mine, cellTot);
    }

    // ══════════════════════════════════════════════════════════════
    // Internal
    // ══════════════════════════════════════════════════════════════

    /// @notice Window index for timestamp t, and the window's [start, end).
    /// @dev The single source of truth for where a boundary sits. Anchored at
    ///      roundEpoch and stepping by roundDuration, so it depends on nothing
    ///      but the clock — which is what lets an empty lobby still count down.
    ///      Timestamps at or before the anchor clamp to window 0 (no underflow).
    function _windowOf(uint64 t) internal view returns (uint64 wStart, uint64 wEnd) {
        uint64 epoch = roundEpoch;
        uint64 dur = uint64(roundDuration);
        uint64 wIdx = t > epoch ? (t - epoch) / dur : 0;
        wStart = epoch + wIdx * dur;
        wEnd = wStart + dur;
    }

    /// @notice The window a stake at `t` would land in: the window containing
    ///         `t`, or the next one when fewer than MIN_BET_WINDOW seconds are
    ///         left in it.
    /// @dev Shared by _startNewRound and currentWindow so the countdown a
    ///      client renders is exactly the window its stake will buy into.
    function _bettableWindow(uint64 t) internal view returns (uint64 wStart, uint64 wEnd) {
        (wStart, wEnd) = _windowOf(t);
        if (wEnd - t < MIN_BET_WINDOW) {
            wStart = wEnd;
            wEnd = wStart + uint64(roundDuration);
        }
    }

    function _startNewRound() internal {
        currentRoundId++;
        uint64 start = uint64(block.timestamp);
        // Grid-aligned: betting closes on a boundary of the time grid, not
        // roundDuration seconds after whoever happened to stake first.
        (, uint64 end) = _bettableWindow(start);
        uint64 drandRound = beacon.roundAt(uint256(end) + beaconGap);
        // Fairness invariant carried over from V6: the pinned beacon must not
        // exist while betting is open, and the window must actually be open.
        require(beacon.timeOfRound(drandRound) > end, "Beacon not future");
        require(end > start, "Window closed");

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
    function setBeacon(address _v) external onlyOwner { require(_v != address(0), "Zero address"); emit BeaconUpdated(address(beacon), _v); beacon = DrandBeacon(_v); }
    function setMinStake(uint256 _v) external onlyOwner { require(_v >= MIN_STAKE_LO && _v <= MIN_STAKE_HI, "Out of bounds"); minStakeWei = _v; emit ConfigUpdated("minStakeWei", _v); }
    /// @dev Changing the step re-phases the grid around the unchanged
    ///      roundEpoch anchor, so the next boundary moves. Accepted: it is
    ///      owner-only, the live round keeps the endTime it opened with, and
    ///      the new window is still strictly in the future.
    function setRoundDuration(uint256 _v) external onlyOwner { require(_v >= 10 && _v <= 3600, "10s-1h"); roundDuration = _v; emit ConfigUpdated("roundDuration", _v); }
    function setBeaconGap(uint256 _v) external onlyOwner { require(_v >= 3 && _v <= 60, "3-60s"); beaconGap = _v; emit ConfigUpdated("beaconGap", _v); }
    function setResolverTip(uint256 _v) external onlyOwner { require(_v <= MAX_RESOLVER_TIP, "Tip>0.001"); resolverTipWei = _v; emit ConfigUpdated("resolverTipWei", _v); }
    function setProtocolFeeBps(uint256 _v) external onlyOwner { require(_v <= 2000, "Fee>20%"); protocolFeeBps = _v; emit ConfigUpdated("protocolFeeBps", _v); }

    function withdrawFees() external onlyOwner {
        uint256 amount = accumulatedFees;
        accumulatedFees = 0;
        (bool ok, ) = feeRecipient.call{value: amount}("");
        require(ok, "ETH send failed");
    }

    /// @notice Sweep only funds owed to nobody. The owner can NEVER touch
    ///         player stakes, refunds, escrowed winnings, the bonus reserve,
    ///         or unclaimed fees. With continuous rounds several staked
    ///         rounds can be pending at once, so the stake reserve is the
    ///         cross-round accumulator, not the current round's pot.
    function sweepSurplus() external onlyOwner {
        uint256 reservedFunds = totalUnresolvedStakes
            + pendingRefunds
            + pendingWithdrawals
            + accumulatedFees;
        uint256 bal = address(this).balance;
        require(bal > reservedFunds, "No surplus");
        (bool ok, ) = owner().call{value: bal - reservedFunds}("");
        require(ok, "ETH send failed");
    }

    /// @dev Strays land as sweepable surplus.
    receive() external payable {}
}
