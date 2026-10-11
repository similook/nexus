/**
 * What the desktop subscription Share sheet will share (src/components/SubscriptionShareSheet.tsx).
 *
 *   npx tsx scripts/check-share.mts
 *
 * The link is shared exactly as the user added it - never rewritten - and only when it is an
 * importable http(s) URL. Missing or invalid stored values share nothing.
 */
import { shareableSubscriptionUrl } from '../src/components/SubscriptionShareSheet';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

// Valid: shared byte for byte (trimmed), query and fragment included - panels key off them.
const valid = 'https://panel.example.com/api/v1/client/subscribe?token=abc123&flag=clash#Main';
check('valid https', shareableSubscriptionUrl(valid), valid);
check('valid http', shareableSubscriptionUrl('http://sub.example.org/s/xyz'), 'http://sub.example.org/s/xyz');
check('valid with port and path', shareableSubscriptionUrl('https://example.net:8443/sub/a.txt'), 'https://example.net:8443/sub/a.txt');
check('surrounding whitespace trimmed', shareableSubscriptionUrl(`  ${valid}\n`), valid);
check('not percent-rewritten', shareableSubscriptionUrl('https://example.com/s?name=a b'), 'https://example.com/s?name=a b');

// Missing.
check('undefined', shareableSubscriptionUrl(undefined), null);
check('null', shareableSubscriptionUrl(null), null);
check('empty', shareableSubscriptionUrl(''), null);
check('whitespace only', shareableSubscriptionUrl('   '), null);

// Invalid.
check('not a URL', shareableSubscriptionUrl('not a url'), null);
check('no scheme', shareableSubscriptionUrl('example.com/sub'), null);
check('config link, not a subscription', shareableSubscriptionUrl('vless://uuid@example.com:443#a'), null);
check('javascript scheme', shareableSubscriptionUrl('javascript:alert(1)'), null);
check('file scheme', shareableSubscriptionUrl('file:///C:/secrets.txt'), null);
check('data scheme', shareableSubscriptionUrl('data:text/plain,hello'), null);
check('no host', shareableSubscriptionUrl('https://'), null);

console.log(`${passed}/${passed + failed} share checks passed`);
if (failed > 0) process.exit(1);
