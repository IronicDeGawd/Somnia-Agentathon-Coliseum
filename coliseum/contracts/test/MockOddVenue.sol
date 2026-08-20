// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockOddVenue — an address that ANSWERS but not in the expected shape.
///
/// The dangerous case is not a venue that reverts; that is loud. It is an address
/// whose call SUCCEEDS while returning something else — a proxy with a fallback, a
/// venue upgraded to a different return shape, or simply the wrong address that
/// happens to have a catch-all. A decode against that data fails with no reason at
/// all, which is the same swallowed-cause fault the rest of this work exists to end.
///
/// Returns a single word where two are expected, and never reverts.
contract MockOddVenue {
    fallback(bytes calldata) external payable returns (bytes memory) {
        return abi.encode(uint256(1));
    }

    receive() external payable {}
}
