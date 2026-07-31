// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GriddyV2} from "../GriddyV2.sol";

/// @notice Winner whose receive() reverts — exercises the escrow/pull path
contract RevertingReceiver {
    function stakeVia(GriddyV2 griddy, uint256 roundId, uint8 cell) external payable {
        uint8[] memory cells = new uint8[](1);
        uint256[] memory amounts = new uint256[](1);
        cells[0] = cell;
        amounts[0] = msg.value;
        griddy.stake{value: msg.value}(roundId, cells, amounts);
    }

    function withdrawVia(GriddyV2 griddy) external {
        allowReceive = true;
        griddy.withdrawWinnings();
        allowReceive = false;
    }

    bool public allowReceive;

    receive() external payable {
        require(allowReceive, "no thanks");
    }
}

/// @notice Layout-safe next implementation for upgrade tests: appends one var
/// @custom:oz-upgrades-unsafe-allow constructor missing-initializer
contract GriddyV2MockNext is GriddyV2 {
    uint256 public newVar;

    function setNewVar(uint256 v) external {
        newVar = v;
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}
