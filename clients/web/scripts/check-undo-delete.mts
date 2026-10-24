/**
 * Undo for deleting a subscription or a manual config (src/core/undoDelete.ts), as
 * useSubscriptions.restore/restoreManual and Toast.tsx's undo bar use it.
 *
 *   npx --yes tsx scripts/check-undo-delete.mts
 *
 * What must hold: Undo puts the item back at the index it had, with the same id and data; an
 * index past the end (the list shrank meanwhile) lands at the end; an item added again meanwhile
 * is not duplicated; a second delete makes the first final, and its Undo does nothing; the window
 * closes at ten seconds; Undo still works after a refresh, of another subscription or of the
 * deleted one itself; a restored node keeps its id when the ML-KEM switch changed meanwhile.
 */

// localStorage before anything that reads it.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const u = await import('../src/core/undoDelete');
const { parseSingleConfig } = await import('../src/core/subscription');
const { rebuildWithRealityMlkem, realityMlkemKey } = await import('../src/core/realityMlkem');

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}

interface Rec {
  id: string;
  url: string;
  name: string;
  nodes: string[];
}
const rec = (id: string, nodes: string[] = [`${id}-1`]): Rec => ({ id, url: `https://panel.invalid/${id}`, name: id, nodes });
const ids = (list: readonly { id: string }[] | null) => (list === null ? null : list.map((r) => r.id).join(','));

/** What useSubscriptions.importInto does to the list when a refresh of `existingId` lands. */
function refreshLands(prev: Rec[], refreshed: Rec, existingId: string): Rec[] {
  return prev.map((r) => (r.id === existingId ? refreshed : r));
}

/** A delete as the UI does it: the index in the list now, then the list without it. */
function del<T extends { id: string }>(list: T[], id: string): { list: T[]; item: T; index: number } {
  const index = list.findIndex((x) => x.id === id);
  return { list: list.filter((x) => x.id !== id), item: list[index], index };
}

// --- restoreAt: same place, same item -------------------------------------------------------
{
  const all = [rec('A'), rec('B'), rec('C')];
  for (const id of ['A', 'B', 'C']) {
    const d = del(all, id);
    const back = u.restoreAt(d.list, d.item, d.index, u.sameSubscription);
    check(`restore ${id} at its index`, ids(back) === 'A,B,C', ids(back));
    check(`restore ${id} is the same record`, back !== null && back[d.index] === d.item);
  }
  const d = del(all, 'B');
  const before = ids(d.list);
  u.restoreAt(d.list, d.item, d.index);
  check('restoreAt does not mutate its input', ids(d.list) === before);
}

// --- restoreAt: indexes the list no longer has ----------------------------------------------
{
  const list = [rec('A')];
  check('index past the end lands at the end', ids(u.restoreAt(list, rec('Z'), 5)) === 'A,Z');
  check('negative index lands first', ids(u.restoreAt(list, rec('Z'), -3)) === 'Z,A');
  check('negative index lands first in a longer list too', ids(u.restoreAt([rec('A'), rec('B'), rec('C')], rec('Z'), -1)) === 'Z,A,B,C');
  check('NaN index lands at the end', ids(u.restoreAt(list, rec('Z'), Number.NaN)) === 'A,Z');
  check('fractional index truncates', ids(u.restoreAt([rec('A'), rec('B')], rec('Z'), 1.9)) === 'A,Z,B');
  check('restore into an empty list', ids(u.restoreAt([], rec('Z'), 2)) === 'Z');
}

// --- restoreAt: added again meanwhile ------------------------------------------------------
{
  const list = [rec('A'), rec('B')];
  check('same id already there: nothing restored', u.restoreAt(list, rec('B'), 0) === null);
  const sameUrl = { ...rec('B2'), url: rec('B').url };
  check('same URL re-added under a new id: nothing restored', u.restoreAt(list, sameUrl, 1, u.sameSubscription) === null);
  check('default comparison is the id only', ids(u.restoreAt(list, sameUrl, 1)) === 'A,B2,B');
}

// --- a second delete makes the first final --------------------------------------------------
{
  const t0 = 1_000_000;
  const log: string[] = [];
  const first = u.nextUndo(0, 'A deleted', () => log.push('A'), t0);
  check('first deletion: seq 1', first.seq === 1);
  check('window is ten seconds', first.deadline - t0 === 10_000 && u.UNDO_WINDOW_MS === 10_000);
  const second = u.nextUndo(first.seq, 'C deleted', () => log.push('C'), t0 + 2000);
  check('second deletion: a new seq', second.seq === 2);
  check('second deletion: its own deadline', second.deadline === t0 + 12_000);
  check('Undo on the first bar after the second delete: nothing', u.takeUndo(second, first.seq, t0 + 3000) === null);
  const run = u.takeUndo(second, second.seq, t0 + 3000);
  check('Undo on the current bar: its own undo', run !== null);
  run?.();
  check('only the second deletion was undone', log.join(',') === 'C', log);
  check('nothing pending: nothing to undo', u.takeUndo(null, 1, t0) === null);
}

// --- the window closes at ten seconds -------------------------------------------------------
{
  const t0 = 5_000;
  const p = u.nextUndo(0, 'x deleted', () => {}, t0);
  check('undo just before the deadline', u.takeUndo(p, p.seq, t0 + 9999) !== null);
  check('no undo at the deadline', u.takeUndo(p, p.seq, t0 + 10_000) === null);
  check('no undo after it', u.takeUndo(p, p.seq, t0 + 60_000) === null);
  const shown = [0, 1, 999, 1000, 1001, 5500, 9000, 9999, 10_000, 12_000].map((dt) => u.secondsLeft(p.deadline, t0 + dt));
  check('countdown 10..1, then 0', shown.join(',') === '10,10,10,9,9,5,1,1,0,0', shown);
}

// --- undo after a refresh -------------------------------------------------------------------
{
  // Delete B, then a refresh of A lands, then Undo.
  const d = del([rec('A'), rec('B'), rec('C')], 'B');
  const afterRefresh = refreshLands(d.list, rec('A', ['A-1', 'A-2']), 'A');
  const back = u.restoreAt(afterRefresh, d.item, d.index, u.sameSubscription);
  check('undo after another subscription refreshed: same place', ids(back) === 'A,B,C', ids(back));
  check('undo after another subscription refreshed: the refresh is kept', back !== null && back[0].nodes.length === 2);

  // A refresh of B itself lands while B is deleted: it does not bring B back.
  const whileGone = refreshLands(d.list, rec('B', ['B-new']), 'B');
  check('a refresh of the deleted subscription does not resurrect it', ids(whileGone) === 'A,C');
  const restored = u.restoreAt(whileGone, d.item, d.index, u.sameSubscription);
  check('undo then brings back the data as deleted', restored !== null && restored[1].nodes.join() === 'B-1');

  // After Undo the id is the same, so a refresh still in flight lands on it in place.
  const late = restored === null ? null : refreshLands(restored, rec('B', ['B-new']), 'B');
  check('a late refresh lands on the restored subscription in place', late !== null && ids(late) === 'A,B,C' && late[1].nodes.join() === 'B-new');
}

// --- the whole flow, as Toast.tsx and ServersView run it -------------------------------------
{
  let subs = [rec('A'), rec('B'), rec('C')];
  let pending: import('../src/core/undoDelete').PendingUndo | null = null;
  let lastSeq = 0;
  const remove = (id: string, now: number) => {
    const d = del(subs, id);
    subs = d.list;
    pending = u.nextUndo(lastSeq, `${id} deleted`, () => {
      const next = u.restoreAt(subs, d.item, d.index, u.sameSubscription);
      if (next !== null) subs = next;
    }, now);
    lastSeq = pending.seq;
    return pending.seq;
  };
  const tap = (seq: number, now: number) => {
    const run = u.takeUndo(pending, seq, now);
    pending = null;
    run?.();
  };
  const seqA = remove('A', 0);
  const seqC = remove('C', 1000);
  tap(seqA, 1500);
  check('flow: Undo on a replaced bar leaves both deleted', ids(subs) === 'B', ids(subs));
  const seqB = remove('B', 2000);
  tap(seqB, 2500);
  check('flow: Undo on the current bar restores it', ids(subs) === 'B', ids(subs));
  const seqB2 = remove('B', 3000);
  check('flow: seqs increase and are never reused after a bar closes', seqA < seqC && seqC < seqB && seqB < seqB2);
  tap(seqB2, 3000 + 10_000);
  check('flow: Undo after the window does nothing', ids(subs) === '', ids(subs));
}

// --- a restored node keeps its id when the ML-KEM switch changed meanwhile -------------------
{
  const uri = `vless://11111111-2222-3333-4444-555555555555@example.invalid:443?type=tcp&security=reality&pbk=${'A'.repeat(43)}&sid=ab&fp=chrome&sni=example.invalid#undo-test`;
  const node = parseSingleConfig(uri);
  const key = realityMlkemKey(uri);
  check('test node is REALITY with a switch key', key !== null);
  const rebuilt = rebuildWithRealityMlkem(node, new Set(key === null ? [] : [key]));
  check('rebuilt for the switch: same id', rebuilt.id === node.id);
  check('rebuilt for the switch: the config now offers the share', rebuilt.config.includes('"support_x25519mlkem768":true') && !node.config.includes('"support_x25519mlkem768":true'));
  const back = u.restoreAt([], rebuilt, 0);
  check('restoreManual-style restore keeps that id', back !== null && back[0].id === node.id);
}

console.log(`check-undo-delete: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
