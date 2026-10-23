// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BTU AI Skills Digital Passport registry (Polygon Amoy)
/// @notice Registers every officially issued passport version. Only hashes are stored:
///         - docHash:     SHA-256 of the passport PDF
///         - codeHash:    keccak256 of the verification code (BTUV-XXXX-XXXX-XXXX)
///         - passportRef: keccak256 of the Passport ID
///         No names, e-mails or skills are written on-chain.
/// @dev Issuer authenticity: only the BTU issuer address can write. BTU publishes the contract
///      address and the issuer address in its DID document (did:web:btu.edu.ge), so any verifier
///      can confirm that a record was written by BTU.
///      The website writes all new versions of one sync in a single issueBatch transaction.
contract PassportRegistry {
    string public constant ISSUER_NAME = "Business and Technology University (BTU)";
    string public constant ISSUER_DID = "did:web:btu.edu.ge";

    address public issuer;

    struct Version {
        bytes32 passportRef;
        uint32 version;
        uint64 issuedAt;
        bool exists;
    }

    mapping(bytes32 => Version) private documents;      // docHash => version record
    mapping(bytes32 => bytes32) public docByCode;       // codeHash => docHash
    mapping(bytes32 => uint32) public latestVersion;    // passportRef => latest version number

    event PassportVersionIssued(bytes32 indexed docHash, bytes32 indexed passportRef, bytes32 codeHash, uint32 version, uint64 issuedAt);
    event IssuerTransferred(address indexed previousIssuer, address indexed newIssuer);

    modifier onlyIssuer() {
        require(msg.sender == issuer, "Only BTU can issue");
        _;
    }

    constructor() {
        issuer = msg.sender;
        emit IssuerTransferred(address(0), msg.sender);
    }

    /// @notice Register many passport versions in one transaction (oldest first).
    ///         Already registered documents are skipped, so a retry is safe.
    function issueBatch(
        bytes32[] calldata docHashes,
        bytes32[] calldata codeHashes,
        bytes32[] calldata passportRefs,
        uint32[] calldata versions
    ) external onlyIssuer {
        uint256 n = docHashes.length;
        require(codeHashes.length == n && passportRefs.length == n && versions.length == n, "Length mismatch");
        for (uint256 i = 0; i < n; i++) {
            _issue(docHashes[i], codeHashes[i], passportRefs[i], versions[i]);
        }
    }

    /// @notice Register a single passport version.
    function issue(bytes32 docHash, bytes32 codeHash, bytes32 passportRef, uint32 version) external onlyIssuer {
        _issue(docHash, codeHash, passportRef, version);
    }

    function _issue(bytes32 docHash, bytes32 codeHash, bytes32 passportRef, uint32 version) private {
        if (documents[docHash].exists) return;
        require(docByCode[codeHash] == bytes32(0), "Verification code already used");
        require(version > latestVersion[passportRef], "Version must be newer than the latest one");
        uint64 ts = uint64(block.timestamp);
        documents[docHash] = Version(passportRef, version, ts, true);
        docByCode[codeHash] = docHash;
        latestVersion[passportRef] = version;
        emit PassportVersionIssued(docHash, passportRef, codeHash, version, ts);
    }

    /// @notice Public check of a PDF (free to call, no account needed).
    function verify(bytes32 docHash)
        external
        view
        returns (bool issued, bool isLatest, bytes32 passportRef, uint32 version, uint64 issuedAt, address issuedBy)
    {
        Version memory v = documents[docHash];
        if (!v.exists) return (false, false, bytes32(0), 0, 0, address(0));
        return (true, latestVersion[v.passportRef] == v.version, v.passportRef, v.version, v.issuedAt, issuer);
    }

    /// @notice Public check of a verification code: pass keccak256 of the code.
    function verifyCode(bytes32 codeHash)
        external
        view
        returns (bool issued, bool isLatest, bytes32 docHash, uint32 version, uint64 issuedAt, address issuedBy)
    {
        bytes32 d = docByCode[codeHash];
        Version memory v = documents[d];
        if (d == bytes32(0) || !v.exists) return (false, false, bytes32(0), 0, 0, address(0));
        return (true, latestVersion[v.passportRef] == v.version, d, v.version, v.issuedAt, issuer);
    }

    function transferIssuer(address newIssuer) external onlyIssuer {
        require(newIssuer != address(0), "Zero address");
        emit IssuerTransferred(issuer, newIssuer);
        issuer = newIssuer;
    }
}
