// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Kanopy registry: attested forest baselines and one claim per cell per year
/// @notice Two records live here. An attestation is the fingerprint of one measurement of a
///         reserve: the boundary, the input rasters, the code and the result. A claim says that a
///         project counts a set of grid cells for one year. A cell can be claimed once per year,
///         by anyone, so overlapping projects cannot count the same ground twice.
/// @dev    The grid is 0.01 degrees, anchored at 90 S 180 W. A cell is (lat index, lon index).
///         Cells are packed 256 to a word: a Row is (lat, lon >> 8, mask) with bit (lon & 255) set.
///         Nothing here issues, prices or transfers a credit.
contract KanopyRegistry {
    struct Row {
        uint32 lat;
        uint16 word;
        uint256 mask;
    }

    struct Reserve {
        string name;
        address steward;
        bytes32 boundaryHash;
        bytes32 footprintHash;
        uint32 cellCount;
        uint32 baselineCount;
    }

    /// @dev Hashes are SHA-256 of the published files. Carbon is above-ground only, in thousands
    ///      of tonnes of CO2 equivalent, and the uncertainty is one standard deviation.
    struct Baseline {
        bytes32 inputsHash;
        bytes32 codeHash;
        bytes32 resultHash;
        uint32 areaHa;
        uint32 co2eKt;
        uint32 co2eSdKt;
        uint16 dataThroughYear;
        uint64 attestedAt;
        address attester;
        string uri;
    }

    struct Claim {
        bytes32 reserveId;
        uint16 year;
        uint32 baselineVersion;
        uint32 cellCount;
        uint64 claimedAt;
        address claimant;
    }

    address public owner;
    mapping(address => bool) public isAttester;

    bytes32[] public reserveIds;
    mapping(bytes32 => Reserve) public reserves;
    mapping(bytes32 => mapping(uint256 => uint256)) private _footprint;
    mapping(bytes32 => mapping(uint32 => Baseline)) private _baselines;

    Claim[] private _claims;
    mapping(uint16 => mapping(uint256 => uint256)) private _claimed;

    event AttesterSet(address indexed attester, bool allowed);
    event ReserveRegistered(bytes32 indexed reserveId, string name, address steward, bytes32 boundaryHash, bytes32 footprintHash, uint32 cellCount);
    event StewardChanged(bytes32 indexed reserveId, address steward);
    event BaselineAttested(bytes32 indexed reserveId, uint32 version, bytes32 resultHash, address attester);
    event Claimed(uint256 indexed claimId, bytes32 indexed reserveId, uint16 indexed year, uint32 baselineVersion, uint32 cellCount, Row[] rows);

    error NotOwner();
    error NotAttester();
    error NotSteward();
    error ReserveExists();
    error UnknownReserve();
    error UnknownBaseline();
    error BadRows();
    error OutsideFootprint(uint32 lat, uint16 word, uint256 outside);
    error CellsAlreadyClaimed(uint16 year, uint32 lat, uint16 word, uint256 taken);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setAttester(address attester, bool allowed) external onlyOwner {
        isAttester[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    /// @notice Record a reserve, who may claim for it, and which grid cells it covers.
    /// @dev Footprints of different reserves may overlap: boundaries are disputed in real life.
    ///      What cannot overlap is a claim.
    function registerReserve(bytes32 reserveId, string calldata name, address steward, bytes32 boundaryHash, Row[] calldata rows)
        external
        onlyOwner
    {
        if (reserves[reserveId].cellCount != 0) revert ReserveExists();
        uint32 cells = _checkRows(rows);
        mapping(uint256 => uint256) storage fp = _footprint[reserveId];
        for (uint256 k = 0; k < rows.length; k++) {
            fp[_key(rows[k].lat, rows[k].word)] = rows[k].mask;
        }
        bytes32 footprintHash = keccak256(abi.encode(rows));
        reserves[reserveId] = Reserve(name, steward, boundaryHash, footprintHash, cells, 0);
        reserveIds.push(reserveId);
        emit ReserveRegistered(reserveId, name, steward, boundaryHash, footprintHash, cells);
    }

    function setSteward(bytes32 reserveId, address steward) external onlyOwner {
        if (reserves[reserveId].cellCount == 0) revert UnknownReserve();
        reserves[reserveId].steward = steward;
        emit StewardChanged(reserveId, steward);
    }

    /// @notice Record the fingerprint of one measurement. Versions are append-only: a new
    ///         measurement gets the next number and the earlier ones stay readable.
    function attest(
        bytes32 reserveId,
        bytes32 inputsHash,
        bytes32 codeHash,
        bytes32 resultHash,
        uint32 areaHa,
        uint32 co2eKt,
        uint32 co2eSdKt,
        uint16 dataThroughYear,
        string calldata uri
    ) external returns (uint32 version) {
        if (!isAttester[msg.sender]) revert NotAttester();
        Reserve storage r = reserves[reserveId];
        if (r.cellCount == 0) revert UnknownReserve();
        version = ++r.baselineCount;
        _baselines[reserveId][version] =
            Baseline(inputsHash, codeHash, resultHash, areaHa, co2eKt, co2eSdKt, dataThroughYear, uint64(block.timestamp), msg.sender, uri);
        emit BaselineAttested(reserveId, version, resultHash, msg.sender);
    }

    /// @notice Count a set of cells for one year under a reserve, citing the measurement relied on.
    ///         Reverts if any cell is outside the reserve or is already counted for that year.
    function claim(bytes32 reserveId, uint16 year, uint32 baselineVersion, Row[] calldata rows) external returns (uint256 claimId) {
        Reserve storage r = reserves[reserveId];
        if (r.cellCount == 0) revert UnknownReserve();
        if (msg.sender != r.steward) revert NotSteward();
        if (baselineVersion == 0 || baselineVersion > r.baselineCount) revert UnknownBaseline();
        uint32 cells = _checkRows(rows);
        mapping(uint256 => uint256) storage fp = _footprint[reserveId];
        mapping(uint256 => uint256) storage taken = _claimed[year];
        for (uint256 k = 0; k < rows.length; k++) {
            uint256 key = _key(rows[k].lat, rows[k].word);
            uint256 mask = rows[k].mask;
            uint256 outside = mask & ~fp[key];
            if (outside != 0) revert OutsideFootprint(rows[k].lat, rows[k].word, outside);
            uint256 already = taken[key];
            if (mask & already != 0) revert CellsAlreadyClaimed(year, rows[k].lat, rows[k].word, mask & already);
            taken[key] = already | mask;
        }
        claimId = _claims.length;
        _claims.push(Claim(reserveId, year, baselineVersion, cells, uint64(block.timestamp), msg.sender));
        emit Claimed(claimId, reserveId, year, baselineVersion, cells, rows);
    }

    // ── Read side ────────────────────────────────────────────────────────────

    function reserveCount() external view returns (uint256) {
        return reserveIds.length;
    }

    function baseline(bytes32 reserveId, uint32 version) external view returns (Baseline memory) {
        if (version == 0 || version > reserves[reserveId].baselineCount) revert UnknownBaseline();
        return _baselines[reserveId][version];
    }

    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    function footprintWord(bytes32 reserveId, uint32 lat, uint16 word) external view returns (uint256) {
        return _footprint[reserveId][_key(lat, word)];
    }

    function claimedWord(uint16 year, uint32 lat, uint16 word) external view returns (uint256) {
        return _claimed[year][_key(lat, word)];
    }

    function isClaimed(uint16 year, uint32 lat, uint32 lon) external view returns (bool) {
        return (_claimed[year][_key(lat, uint16(lon >> 8))] >> (lon & 255)) & 1 == 1;
    }

    /// @notice How many of these cells are already counted for the year.
    function conflicts(uint16 year, Row[] calldata rows) external view returns (uint32 cells) {
        mapping(uint256 => uint256) storage taken = _claimed[year];
        for (uint256 k = 0; k < rows.length; k++) {
            cells += _popcount(rows[k].mask & taken[_key(rows[k].lat, rows[k].word)]);
        }
    }

    /// @notice For each row, which of its cells are already counted for the year.
    function claimedMasks(uint16 year, Row[] calldata rows) external view returns (uint256[] memory taken) {
        taken = new uint256[](rows.length);
        for (uint256 k = 0; k < rows.length; k++) {
            taken[k] = rows[k].mask & _claimed[year][_key(rows[k].lat, rows[k].word)];
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _key(uint32 lat, uint16 word) private pure returns (uint256) {
        return (uint256(lat) << 16) | word;
    }

    /// @dev Rows must be non-empty, have a non-zero mask and be strictly ascending by (lat, word),
    ///      which rules out naming the same cell twice in one call.
    function _checkRows(Row[] calldata rows) private pure returns (uint32 cells) {
        if (rows.length == 0) revert BadRows();
        uint256 last;
        for (uint256 k = 0; k < rows.length; k++) {
            uint256 key = _key(rows[k].lat, rows[k].word);
            if (rows[k].mask == 0 || (k != 0 && key <= last)) revert BadRows();
            last = key;
            cells += _popcount(rows[k].mask);
        }
    }

    function _popcount(uint256 x) private pure returns (uint32 n) {
        while (x != 0) {
            x &= x - 1;
            n++;
        }
    }
}
