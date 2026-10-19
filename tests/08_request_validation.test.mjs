// Request validation against openapi.yaml with express-openapi-validator 5.6.2.
// Run: OPENAPI=../04_api/openapi.yaml node tests/08_request_validation.test.mjs   (expected: 14 PASS)
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';
const app = express(); app.use(express.json());
app.use(OpenApiValidator.middleware({ apiSpec: process.env.OPENAPI ?? 'openapi.yaml', validateRequests: true, validateResponses: false, validateSecurity: false, ignoreUndocumented: false, serDes: [], $refParser: { mode: 'dereference' } }));
app.post('/api/v1/variables', (req, res) => res.status(201).json({ ok: true }));
app.get('/api/v1/variables', (req, res) => res.json({ ok: true }));
app.put('/api/v1/screens/:id', (req, res) => res.json({ ok: true }));
app.post('/api/v1/applications', (req, res) => res.status(201).json({ ok: true }));
app.post('/api/v1/screens/:id/comments', (req, res) => res.status(201).json({ ok: true }));
app.get('/api/v1/search', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => res.status(err.status || 500).json({ code: 'VALIDATION_ERROR', message: err.message, details: { fields: (err.errors || []).map(e => ({ field: e.path, issue: e.errorCode, message: e.message })) } }));
const base = { applicationId: 1, name: 'gUsuario', dataType: 'RECORD', scope: 'GLOBAL', environments: [{ environment: 'DEV' }] };
const run = async (label, r, exp) => { const res = await r; console.log((res.status === exp ? 'PASS ' : 'FAIL ') + label + ' -> ' + res.status + (res.status >= 400 ? ' ' + JSON.stringify(res.body.details?.fields?.[0] ?? res.body.message).slice(0, 110) : '')); };
await run('V1 valid body accepted', request(app).post('/api/v1/variables').send(base), 201);
await run('V2 missing environments', request(app).post('/api/v1/variables').send({ ...base, environments: [] }), 400);
await run('V3 unknown dataType', request(app).post('/api/v1/variables').send({ ...base, dataType: 'STRING' }), 400);
await run('V4 extra property rejected', request(app).post('/api/v1/variables').send({ ...base, hack: true }), 400);
await run('V5 description null allowed (3.1 type array)', request(app).post('/api/v1/variables').send({ ...base, description: null }), 201);
await run('V6 listing without applicationId', request(app).get('/api/v1/variables'), 400);
await run('V7 pageSize over 100', request(app).get('/api/v1/variables?applicationId=1&pageSize=500'), 400);
const scr = { name: 'Inicio', template: { onStart: null, workingProcess: null, architecture: null, dataModel: null, requirements: null, knownIssues: null, risks: null }, components: [], variableLinks: [], collectionLinks: [], navigations: [] };
await run('V8 PUT screen valid', request(app).put('/api/v1/screens/3').send(scr), 200);
await run('V9 PUT screen extra property (status cannot be sent here)', request(app).put('/api/v1/screens/3').send({ ...scr, documentationStatus: 'APPROVED' }), 400);
await run('V10 POST application extra property', request(app).post('/api/v1/applications').send({ name: 'SAR', platform: 'Power Apps', status: 'ARCHIVED' }), 400);
await run('V11 usedIn "origin" rejected (reserved)', request(app).put('/api/v1/screens/3').send({ ...scr, variableLinks: [{ variableId: 1, accessMode: 'READ', usedIn: 'origin' }] }), 400);

// 0.3.0
await run('V12 POST comment with reviewDecision rejected (CP-11: only the review writes it)', request(app).post('/api/v1/screens/3/comments').send({ text: 'Approved.', reviewDecision: 'APPROVE' }), 400);
await run('V13 GET /search without q but with types accepted by the validator (CP-03)', request(app).get('/api/v1/search?applicationId=1&types=SCREEN'), 200);
await run('V14 GET /search with a one-character q rejected', request(app).get('/api/v1/search?applicationId=1&q=a'), 400);
