/** Run: npx tsx tests/05_jira_signature.test.ts */
import { createHmac } from 'node:crypto';
import { verifyJiraSignature } from '../src/integrations/jira/verifySignature.js';
let fail = 0;
const check = (label: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); };
const secret = 'test-secret-from-env';
const body = Buffer.from(JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { id: '10003', key: 'TECHEA-3' } }));
const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
// Public HMAC-SHA256 test vector used in WebSub/GitHub documentation (secret, "Hello, World!")
check('J0 known HMAC-SHA256 vector', verifyJiraSignature(Buffer.from('Hello, World!'), 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17', "It's a Secret to Everybody"));
check('J1 valid signature accepted', verifyJiraSignature(body, sig, secret));
check('J2 tampered body rejected', !verifyJiraSignature(Buffer.from(body.toString().replace('TECHEA-3', 'TECHEA-4')), sig, secret));
check('J3 wrong secret rejected', !verifyJiraSignature(body, sig, 'other-secret'));
check('J4 missing header rejected', !verifyJiraSignature(body, undefined, secret));
check('J5 unsupported method rejected', !verifyJiraSignature(body, sig.replace('sha256', 'sha1'), secret));
check('J6 truncated signature rejected (no exception)', !verifyJiraSignature(body, sig.slice(0, 20), secret));
check('J7 non-hex signature rejected', !verifyJiraSignature(body, 'sha256=zz' + sig.slice(9), secret));
check('J8 re-serialized JSON rejected (raw body required)', !verifyJiraSignature(Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2)), sig, secret));
console.log(fail === 0 ? 'ALL PASSED' : `${fail} FAILURE(S)`); process.exit(fail ? 1 : 0);
