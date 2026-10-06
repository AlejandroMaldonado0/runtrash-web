const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hashPassword,
    verifyPassword,
    hashSessionToken
} = require('../lib/security');

test('hashPassword genera hashes verificables y únicos', () => {
    const first = hashPassword('una-clave-segura');
    const second = hashPassword('una-clave-segura');

    assert.notEqual(first, second);
    assert.equal(verifyPassword('una-clave-segura', first), true);
    assert.equal(verifyPassword('otra-clave', first), false);
});

test('verifyPassword conserva compatibilidad con contraseñas antiguas', () => {
    assert.equal(verifyPassword('antigua', 'antigua'), true);
    assert.equal(verifyPassword('otra', 'antigua'), false);
});

test('hashSessionToken produce SHA-256 determinista', () => {
    const token = 'token-de-prueba';
    const hash = hashSessionToken(token);

    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash, hashSessionToken(token));
    assert.notEqual(hash, token);
});
