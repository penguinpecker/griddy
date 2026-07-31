// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title $GRIDDY Token (UUPS-upgradeable)
/// @notice ERC20 minted as rewards to Griddy round winners, pro-rata by stake
contract GriddyTokenV2 is Initializable, ERC20Upgradeable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// @notice Hard lifetime cap — emission is a schedule, not a faucet
    uint256 public constant MAX_SUPPLY = 100_000_000e18;

    mapping(address => bool) public minters;
    uint256[49] private __gap;

    event MinterUpdated(address indexed minter, bool allowed);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        require(owner_ != address(0), "Zero address");
        __ERC20_init("Griddy", "GRIDDY");
        __Ownable_init(owner_);
        __Ownable2Step_init();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setMinter(address _minter, bool _allowed) external onlyOwner {
        minters[_minter] = _allowed;
        emit MinterUpdated(_minter, _allowed);
    }

    function mint(address to, uint256 amount) external {
        require(minters[msg.sender], "Not a minter");
        require(totalSupply() + amount <= MAX_SUPPLY, "Cap exceeded");
        _mint(to, amount);
    }

    /// @notice Permanently disabled — see GriddyV2.renounceOwnership
    function renounceOwnership() public pure override {
        revert("Renounce disabled");
    }
}
