const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');

test('los endpoints de reportes exigen una sesión', async () => {
  const response = await request(app).get('/api/reportes');
  assert.equal(response.status, 401);
  assert.equal(response.body.ok, false);
});

test('el endpoint de crear reporte rechaza usuarios sin sesión', async () => {
  const response = await request(app).post('/api/reportes');
  assert.equal(response.status, 401);
  assert.equal(response.body.ok, false);
});
