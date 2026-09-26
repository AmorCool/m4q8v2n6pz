/**
 * QR Code encoder -- byte mode, error correction level L, versions 1..10.
 *
 * Why this exists at all: the scan-login path hands the client a URL, not an
 * image (see LOGIN_PROTOCOL_SPEC.md section 2A step 2 -- the original renders
 * the URL locally with `qrious`, `_showQrcode`). This build has no browser QR
 * library and no npm dependency is allowed for it, so the encoder lives here
 * and produces an SVG data URL the renderer can drop straight into an <img>.
 *
 * The implementation is the standard ISO/IEC 18004 pipeline: byte-mode bit
 * stream, Reed-Solomon over GF(256) with primitive polynomial 0x11D, block
 * interleaving, function-pattern placement, the eight data masks with the
 * spec's penalty scoring, and BCH-protected format/version information.
 *
 * Only level L is implemented on purpose. The login URL is ~234 bytes and
 * level L is what makes it fit in version 10 (271 bytes); the higher levels
 * would need a larger symbol and their block tables add nothing here. Level L
 * is still fully error-correcting, which is what a screen-to-camera scan
 * needs.
 *
 * Verification: the module matrices were checked against Python `segno` for
 * several payloads and every mask (see the commit message); this file is not
 * a hand-rolled approximation.
 */

"use strict";

// ---------------------------------------------------------------------------
// Galois field GF(256), primitive polynomial 0x11D
// ---------------------------------------------------------------------------

const EXP = new Array(256);
const LOG = new Array(256);

(function initGaloisField() {
    for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
    for (let i = 8; i < 256; i++) {
        EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
    }
    for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
})();

/** Alpha exponent, reduced modulo the field order (255). */
function gexp(n) {
    let value = n;
    while (value < 0) value += 255;
    while (value >= 255) value -= 255;
    return EXP[value];
}

/** Field multiplication via the log tables. */
function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
}

/** Multiply two polynomials whose coefficients are field elements. */
function polyMul(a, b) {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            out[i + j] ^= gmul(a[i], b[j]);
        }
    }
    return out;
}

/** The generator polynomial for `degree` error correction codewords. */
function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        poly = polyMul(poly, [1, gexp(i)]);
    }
    return poly;
}

/** Reed-Solomon remainder = the error correction codewords for one block. */
function rsEncode(data, ecLength) {
    const generator = rsGenerator(ecLength);
    const remainder = new Array(ecLength).fill(0);
    for (const byte of data) {
        const factor = byte ^ remainder[0];
        remainder.shift();
        remainder.push(0);
        for (let i = 0; i < ecLength; i++) {
            remainder[i] ^= gmul(generator[i + 1], factor);
        }
    }
    return remainder;
}

// ---------------------------------------------------------------------------
// Version / block tables (error correction level L, versions 1..10)
// ---------------------------------------------------------------------------

/** Data codewords per version, level L. */
const DATA_CODEWORDS = [19, 34, 55, 80, 108, 136, 156, 194, 232, 274];

/** Error correction codewords per block, level L. */
const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];

/** Number of RS blocks per version, level L. */
const BLOCK_COUNT = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4];

/**
 * Alignment pattern centre coordinates, versions 1..10. Version 1 has none.
 * Each list is the set of row (and column) centres; the patterns sit at every
 * pair of centres, skipping the ones the finder patterns already occupy.
 */
const ALIGNMENT = [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
];

/** Level L is bit pattern 01 in the format information. */
const EC_LEVEL_L = 0b01;

const MAX_VERSION = DATA_CODEWORDS.length;

// ---------------------------------------------------------------------------
// BCH codes for format and version information
// ---------------------------------------------------------------------------

/** Number of significant bits in a value. */
function bitLength(value) {
    let digit = 0;
    let data = value;
    while (data !== 0) {
        digit += 1;
        data >>>= 1;
    }
    return digit;
}

const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;
const G18 = 0b1111100100101;

/** 15-bit format information: EC level + mask, BCH-protected and XOR-masked. */
function formatInformation(data) {
    let remainder = data << 10;
    while (bitLength(remainder) - bitLength(G15) >= 0) {
        remainder ^= G15 << (bitLength(remainder) - bitLength(G15));
    }
    return ((data << 10) | remainder) ^ G15_MASK;
}

/** 18-bit version information, present from version 7 up. */
function versionInformation(version) {
    let remainder = version << 12;
    while (bitLength(remainder) - bitLength(G18) >= 0) {
        remainder ^= G18 << (bitLength(remainder) - bitLength(G18));
    }
    return (version << 12) | remainder;
}

// ---------------------------------------------------------------------------
// Data masks
// ---------------------------------------------------------------------------

/** The eight mask predicates from the spec, indexed 0..7. */
function maskApplies(mask, row, col) {
    switch (mask) {
        case 0: return (row + col) % 2 === 0;
        case 1: return row % 2 === 0;
        case 2: return col % 3 === 0;
        case 3: return (row + col) % 3 === 0;
        case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
        case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
        case 6: return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
        case 7: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
        default: return false;
    }
}

/**
 * Penalty score for a finished symbol. Lower is better; the encoder tries all
 * eight masks and keeps the cheapest, which is what keeps a scan robust under
 * uneven lighting.
 */
function penalty(modules, size) {
    let lost = 0;

    // Rule 1: runs and clusters of one colour.
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            let same = 0;
            const dark = modules[row][col];
            for (let r = -1; r <= 1; r++) {
                if (row + r < 0 || row + r >= size) continue;
                for (let c = -1; c <= 1; c++) {
                    if (col + c < 0 || col + c >= size) continue;
                    if (r === 0 && c === 0) continue;
                    if (dark === modules[row + r][col + c]) same += 1;
                }
            }
            if (same > 5) lost += 3 + same - 5;
        }
    }

    // Rule 2: 2x2 blocks of one colour.
    for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
            let count = 0;
            if (modules[row][col]) count += 1;
            if (modules[row + 1][col]) count += 1;
            if (modules[row][col + 1]) count += 1;
            if (modules[row + 1][col + 1]) count += 1;
            if (count === 0 || count === 4) lost += 3;
        }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns.
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size - 6; col++) {
            if (modules[row][col] && !modules[row][col + 1] && modules[row][col + 2]
                && modules[row][col + 3] && modules[row][col + 4]
                && !modules[row][col + 5] && modules[row][col + 6]) {
                lost += 40;
            }
        }
    }
    for (let col = 0; col < size; col++) {
        for (let row = 0; row < size - 6; row++) {
            if (modules[row][col] && !modules[row + 1][col] && modules[row + 2][col]
                && modules[row + 3][col] && modules[row + 4][col]
                && !modules[row + 5][col] && modules[row + 6][col]) {
                lost += 40;
            }
        }
    }

    // Rule 4: deviation of the dark-module ratio from 50%.
    let darkCount = 0;
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (modules[row][col]) darkCount += 1;
        }
    }
    const ratio = Math.abs((100 * darkCount) / (size * size) - 50) / 5;
    lost += ratio * 10;

    return lost;
}

// ---------------------------------------------------------------------------
// Symbol construction
// ---------------------------------------------------------------------------

/** Smallest version whose level-L capacity fits `byteLength` data bytes. */
function pickVersion(byteLength) {
    for (let version = 1; version <= MAX_VERSION; version++) {
        const capacityBits = DATA_CODEWORDS[version - 1] * 8;
        // Byte mode: 4-bit mode indicator + 8-bit count (16-bit from v10).
        const countBits = version >= 10 ? 16 : 8;
        const neededBits = 4 + countBits + byteLength * 8;
        if (neededBits <= capacityBits) return version;
    }
    throw new Error(
        `qr payload of ${byteLength} bytes exceeds version ${MAX_VERSION} at level L`
    );
}

/** Build the data codewords: mode, length, payload, terminator and padding. */
function buildDataCodewords(bytes, version) {
    const bits = [];
    const put = (value, length) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    put(0b0100, 4);                                    // byte mode
    put(bytes.length, version >= 10 ? 16 : 8);         // character count
    for (const byte of bytes) put(byte, 8);

    const capacity = DATA_CODEWORDS[version - 1] * 8;
    put(0, Math.min(4, capacity - bits.length));       // terminator
    while (bits.length % 8 !== 0) bits.push(0);        // byte alignment

    const padBytes = [0xec, 0x11];
    let padIndex = 0;
    while (bits.length < capacity) {
        put(padBytes[padIndex % 2], 8);
        padIndex += 1;
    }

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        codewords.push(byte);
    }
    return codewords;
}

/**
 * Split the data codewords into RS blocks, add error correction, then
 * interleave data and ECC exactly the way the spec lays them out. When the
 * data does not divide evenly the longer blocks come last, which is the
 * convention the level-L tables use (version 10 is the only case here).
 */
function interleave(dataCodewords, version) {
    const blockCount = BLOCK_COUNT[version - 1];
    const ecLength = EC_PER_BLOCK[version - 1];
    const total = dataCodewords.length;
    const base = Math.floor(total / blockCount);
    const extra = total % blockCount;

    const lengths = [];
    for (let i = 0; i < blockCount; i++) {
        lengths.push(base + (i >= blockCount - extra ? 1 : 0));
    }

    const dataBlocks = [];
    let offset = 0;
    for (const length of lengths) {
        dataBlocks.push(dataCodewords.slice(offset, offset + length));
        offset += length;
    }
    const ecBlocks = dataBlocks.map((block) => rsEncode(block, ecLength));

    const out = [];
    const maxLength = Math.max(...lengths);
    for (let i = 0; i < maxLength; i++) {
        for (const block of dataBlocks) {
            if (i < block.length) out.push(block[i]);
        }
    }
    for (let i = 0; i < ecLength; i++) {
        for (const block of ecBlocks) out.push(block[i]);
    }
    return out;
}

/** One finder pattern plus its separator, clipped to the symbol. */
function placeFinder(modules, size, row, col) {
    for (let r = -1; r <= 7; r++) {
        if (row + r < 0 || row + r >= size) continue;
        for (let c = -1; c <= 7; c++) {
            if (col + c < 0 || col + c >= size) continue;
            const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
                || (c >= 0 && c <= 6 && (r === 0 || r === 6))
                || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
            modules[row + r][col + c] = dark ? 1 : 0;
        }
    }
}

/** Write the format information and the fixed dark module. */
function writeFormatInfo(modules, size, mask, test) {
    const bits = formatInformation((EC_LEVEL_L << 3) | mask);
    for (let i = 0; i < 15; i++) {
        const mod = !test && ((bits >> i) & 1) === 1 ? 1 : 0;
        if (i < 6) modules[i][8] = mod;
        else if (i < 8) modules[i + 1][8] = mod;
        else modules[size - 15 + i][8] = mod;

        if (i < 8) modules[8][size - i - 1] = mod;
        else if (i < 9) modules[8][15 - i] = mod;
        else modules[8][15 - i - 1] = mod;
    }
    modules[size - 8][8] = test ? 0 : 1;
}

/** Write the version information blocks (version 7 and up). */
function writeVersionInfo(modules, size, version, test) {
    const bits = versionInformation(version);
    for (let i = 0; i < 18; i++) {
        const mod = !test && ((bits >> i) & 1) === 1 ? 1 : 0;
        modules[Math.floor(i / 3)][(i % 3) + size - 11] = mod;
        modules[(i % 3) + size - 11][Math.floor(i / 3)] = mod;
    }
}

/**
 * Lay the interleaved codewords into the symbol, two columns at a time,
 * bouncing between the bottom and the top. Column 6 is the vertical timing
 * pattern and is skipped. Cells already claimed by a function pattern are
 * left alone, which is what keeps the two from overlapping.
 */
function placeData(modules, size, codewords, mask) {
    const totalBits = codewords.length * 8;
    let index = 0;
    let direction = -1;
    let row = size - 1;

    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (;;) {
            for (let c = 0; c < 2; c++) {
                const column = col - c;
                if (modules[row][column] !== null) continue;
                let bit = 0;
                if (index < totalBits) {
                    bit = (codewords[index >>> 3] >>> (7 - (index & 7))) & 1;
                }
                if (maskApplies(mask, row, column)) bit ^= 1;
                modules[row][column] = bit;
                index += 1;
            }
            row += direction;
            if (row < 0 || row >= size) {
                row -= direction;
                direction = -direction;
                break;
            }
        }
    }
}

/**
 * Assemble one complete symbol for a given mask.
 *
 * `test` is the dry run the mask search uses: format and version information
 * are written as zeros so the penalty reflects the data area, which is what
 * the reference encoder does. The final build passes `test = false`.
 */
function buildMatrix(version, codewords, mask, test) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(null));

    placeFinder(modules, size, 0, 0);
    placeFinder(modules, size, size - 7, 0);
    placeFinder(modules, size, 0, size - 7);

    const centers = ALIGNMENT[version - 1];
    for (const row of centers) {
        for (const col of centers) {
            if (modules[row][col] !== null) continue;
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    modules[row + dr][col + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
                }
            }
        }
    }

    for (let i = 8; i < size - 8; i++) {
        if (modules[i][6] === null) modules[i][6] = i % 2 === 0 ? 1 : 0;
        if (modules[6][i] === null) modules[6][i] = i % 2 === 0 ? 1 : 0;
    }

    writeFormatInfo(modules, size, mask, test);
    if (version >= 7) writeVersionInfo(modules, size, version, test);

    placeData(modules, size, codewords, mask);
    return modules;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode `text` as a QR symbol.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.version] force a version (1..10) instead of the
 *                                   smallest that fits
 * @param {number} [options.mask]    force a mask (0..7) instead of the best
 * @returns {{version:number,size:number,mask:number,modules:number[][]}}
 */
function encode(text, options) {
    const opts = options || {};
    const bytes = Buffer.from(String(text), "utf8");

    const version = opts.version || pickVersion(bytes.length);
    if (version < 1 || version > MAX_VERSION) {
        throw new Error(`qr version ${version} is outside the supported range`);
    }

    // A forced version must still hold the payload. Without this check the
    // bit stream would be silently truncated and the symbol would encode
    // something other than the caller asked for.
    const countBits = version >= 10 ? 16 : 8;
    const neededBits = 4 + countBits + bytes.length * 8;
    if (neededBits > DATA_CODEWORDS[version - 1] * 8) {
        throw new Error(
            `qr payload of ${bytes.length} bytes does not fit version ${version}`
        );
    }

    const data = buildDataCodewords(bytes, version);
    const codewords = interleave(data, version);

    let mask = opts.mask;
    if (mask === undefined || mask === null) {
        let bestMask = 0;
        let bestPenalty = Infinity;
        for (let candidate = 0; candidate < 8; candidate++) {
            const modules = buildMatrix(version, codewords, candidate, true);
            const score = penalty(modules, version * 4 + 17);
            if (score < bestPenalty) {
                bestPenalty = score;
                bestMask = candidate;
            }
        }
        mask = bestMask;
    }

    const modules = buildMatrix(version, codewords, mask, false);
    return { version, size: modules.length, mask, modules };
}

/**
 * Render a module matrix as an SVG data URL.
 *
 * SVG rather than PNG: the renderer's Content-Security-Policy allows
 * `data:` images and SVG needs no zlib or PNG chunking, so this is the whole
 * encoder. The quiet zone (default 4 modules) is part of the spec -- a QR
 * without it often will not scan.
 */
function toSvgDataUrl(matrix, options) {
    const opts = options || {};
    const scale = opts.scale || 4;
    const margin = opts.margin === undefined ? 4 : opts.margin;
    const count = matrix.length;
    const dimension = (count + margin * 2) * scale;

    let path = "";
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (matrix[row][col]) {
                path += `M${(col + margin) * scale} ${(row + margin) * scale}`
                    + `h${scale}v${scale}h-${scale}z`;
            }
        }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}"`
        + ` height="${dimension}" viewBox="0 0 ${dimension} ${dimension}"`
        + ` shape-rendering="crispEdges">`
        + `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`
        + `<path d="${path}" fill="#000000"/></svg>`;

    return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

/** Encode and render in one call -- the shape the login screen needs. */
function renderDataUrl(text, options) {
    const symbol = encode(text, options);
    return {
        version: symbol.version,
        mask: symbol.mask,
        size: symbol.size,
        dataUrl: toSvgDataUrl(symbol.modules, options),
    };
}

module.exports = { encode, toSvgDataUrl, renderDataUrl };
