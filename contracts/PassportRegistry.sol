// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BTU AI Skills Digital Passport registry
/// @notice Stores only SHA-256 hashes of passport versions. No personal data on-chain.
contract PassportRegistry {
    address public university;

    struct Record {
        uint64 issuedAt;
        bool revoked;
    }

    mapping(bytes32 => Record) private records;

    event PassportIssued(bytes32 indexed hash, uint64 issuedAt);
    event PassportRevoked(bytes32 indexed hash);

    modifier onlyUniversity() {
        require(msg.sender == university, "Not authorized");
        _;
    }

    constructor() {
        university = msg.sender;
    }

    function issue(bytes32 hash) external onlyUniversity {
        require(records[hash].issuedAt == 0, "Already issued");
        records[hash] = Record(uint64(block.timestamp), false);
        emit PassportIssued(hash, uint64(block.timestamp));
    }

    function revoke(bytes32 hash) external onlyUniversity {
        require(records[hash].issuedAt != 0, "Unknown passport");
        records[hash].revoked = true;
        emit PassportRevoked(hash);
    }

    function verify(bytes32 hash)
        external
        view
        returns (bool exists, bool revoked, uint64 issuedAt)
    {
        Record memory r = records[hash];
        return (r.issuedAt != 0, r.revoked, r.issuedAt);
    }
}
