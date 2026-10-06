const crypto = require('node:crypto');

const SCRYPT_KEY_LENGTH = 64;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEY_LENGTH);
    return `scrypt$${salt}$${hash.toString('hex')}`;
}

function verifyPassword(password, storedValue) {
    const stored = String(storedValue ?? '');

    if (!stored.startsWith('scrypt$')) {
        const actual = crypto.createHash('sha256').update(String(password)).digest();
        const expected = crypto.createHash('sha256').update(stored).digest();
        return crypto.timingSafeEqual(actual, expected);
    }

    const [, salt, expectedHex] = stored.split('$');
    if (!salt || !expectedHex) return false;

    const expected = Buffer.from(expectedHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length || SCRYPT_KEY_LENGTH);

    return actual.length === expected.length
        && crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
    hashPassword,
    verifyPassword,
    hashSessionToken
};
