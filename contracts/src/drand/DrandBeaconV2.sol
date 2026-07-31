// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {BLS} from "./BLS.sol";

/// @title DrandBeaconV2
/// @notice Verifies drand beacon signatures on-chain for BN254-based drand
///         networks (e.g. the League of Entropy "evmnet" beacon,
///         scheme bls-bn254-unchained-on-g1). UUPS-upgradeable port of
///         {DrandBeacon} with an identical external API: the beacon config
///         (public key, genesis, period) lives in storage set by initialize
///         instead of constructor immutables. Every new contract in this repo
///         deploys behind a proxy (user directive).
/// @dev Message for round N is keccak256(uint64 big-endian N); signatures are
///      uncompressed G1 points (x || y). Verification logic adapted from
///      anyrand's DrandBeacon (MIT, Kevin Charm / Frogworks).
contract DrandBeaconV2 is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /// @notice RFC 9380 domain separation tag used by BN254 drand networks
    bytes public constant DST =
        bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");

    /// @notice Beacon group public key (BN254 G2, real-parts-first ordering
    ///         as consumed by {BLS.verifySingle})
    uint256 public publicKey0;
    uint256 public publicKey1;
    uint256 public publicKey2;
    uint256 public publicKey3;

    /// @notice Unix timestamp of the beacon's round 1
    uint256 public genesisTimestamp;
    /// @notice Seconds between beacon rounds
    uint256 public period;
    uint256[44] private __gap;

    error InvalidPublicKey(uint256[4] pubKey);
    error InvalidBeaconConfiguration(uint256 genesisTimestamp, uint256 period);
    error InvalidSignature(uint256 round, uint256[2] signature);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        uint256[4] memory pubKey_,
        uint256 genesis_,
        uint256 period_
    ) external initializer {
        __Ownable_init(owner_);

        if (!BLS.isValidPublicKey(pubKey_)) {
            revert InvalidPublicKey(pubKey_);
        }
        if (genesis_ == 0 || period_ == 0) {
            revert InvalidBeaconConfiguration(genesis_, period_);
        }
        publicKey0 = pubKey_[0];
        publicKey1 = pubKey_[1];
        publicKey2 = pubKey_[2];
        publicKey3 = pubKey_[3];
        genesisTimestamp = genesis_;
        period = period_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice The beacon group public key as an array
    function publicKey() public view returns (uint256[4] memory) {
        return [publicKey0, publicKey1, publicKey2, publicKey3];
    }

    /// @notice Unix timestamp at which round `round` is emitted
    function timeOfRound(uint256 round) public view returns (uint256) {
        return genesisTimestamp + (round - 1) * period;
    }

    /// @notice First round emitted at or after `timestamp`
    function roundAt(uint256 timestamp) public view returns (uint64) {
        if (timestamp <= genesisTimestamp) {
            return 1;
        }
        uint256 delta = timestamp - genesisTimestamp;
        return uint64((delta + period - 1) / period + 1);
    }

    /// @notice Verify the signature produced by a drand beacon round against
    ///         the known group public key. Reverts if invalid.
    /// @param round The beacon round number
    /// @param signature Uncompressed G1 signature point (x, y)
    function verifyBeaconRound(
        uint256 round,
        uint256[2] memory signature
    ) external view {
        // message = keccak256(round as uint64 big-endian)
        bytes memory hashedRoundBytes = new bytes(32);
        assembly {
            mstore(0x00, round)
            let hashedRound := keccak256(0x18, 0x08)
            mstore(add(0x20, hashedRoundBytes), hashedRound)
        }

        if (!BLS.isValidSignature(signature)) {
            revert InvalidSignature(round, signature);
        }

        uint256[2] memory message = BLS.hashToPoint(DST, hashedRoundBytes);
        (bool pairingSuccess, bool callSuccess) = BLS.verifySingle(
            signature,
            publicKey(),
            message
        );
        // From EIP-197: the pairing precompile only fails on malformed input,
        // which the checks above rule out.
        assert(callSuccess);
        if (!pairingSuccess) {
            revert InvalidSignature(round, signature);
        }
    }
}
