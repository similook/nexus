/**
 * Back button / Escape (src/core/backButton.ts): the stack logic every overlay relies on.
 *   npx tsx scripts/check-back-button.mts
 */
import { createBackStack } from '../src/core/backButton';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

{
  const back = createBackStack();
  const closed: string[] = [];
  back.push(() => closed.push('details'));
  back.push(() => closed.push('qr'));
  check('the last opened closes first', back.handle() === 'closed' && closed.join() === 'qr');
  // A real overlay removes its own handler when it closes; simulate the QR scanner doing so.
  check('size counts open overlays', back.size === 2);
}

{
  const back = createBackStack();
  const closed: string[] = [];
  const removeDetails = back.push(() => closed.push('details'));
  const removeQr = back.push(() => closed.push('qr'));
  removeQr();
  check('a closed overlay is gone: the one below closes', back.handle() === 'closed' && closed.join() === 'details');
  removeDetails();
  removeDetails();
  check('removing twice is harmless', back.size === 0);
  check('nothing open, no fallback: none', back.handle() === 'none');
}

{
  const back = createBackStack();
  const closed: string[] = [];
  const removeA = back.push(() => closed.push('a'));
  back.push(() => closed.push('b'));
  removeA();
  check('removing a lower overlay keeps the top one on top', back.handle() === 'closed' && closed.join() === 'b');
}

{
  const back = createBackStack();
  let tab = 'servers';
  back.setFallback(() => {
    if (tab === 'home') return false;
    tab = 'home';
    return true;
  });
  check('nothing open on another tab: the fallback goes Home', back.handle() === 'fallback' && tab === 'home');
  check('on Home the fallback declines: none (the app minimises)', back.handle() === 'none');
  const remove = back.push(() => {});
  check('an open overlay wins over the fallback', back.handle() === 'closed');
  remove();
  back.setFallback(null);
  tab = 'logs';
  check('fallback cleared: none', back.handle() === 'none' && tab === 'logs');
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
