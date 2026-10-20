import { useEffect, useMemo, useReducer, useRef } from 'react';
import { coreEvents } from './coreEvents';
import { NexusCore } from './plugin';
import { ServerTestsController, type DelayCell, type MlkemRetry, type TcpCell, type TestAllSummary } from './serverTests';
import type { ServerNode } from '../data/servers';

export type { DelayCell, TcpCell, TestAllSummary } from './serverTests';

export interface ServerTests {
  tcp: Record<string, TcpCell>;
  delay: Record<string, DelayCell>;
  /** While a run is in progress: Delay results received of servers probed. */
  progress: { done: number; total: number } | null;
  start: (nodes: ServerNode[]) => void;
  cancel: () => void;
  recordLive: (id: string, ms: number | null) => void;
}

/**
 * Test All for the Servers screen: TCP and Delay for every server, kept apart. The logic, and
 * the rules for which results may land, live in ServerTestsController (serverTests.ts).
 *
 * Events arrive through coreEvents, never a per-component addListener (see coreEvents.ts).
 */
export function useServerTests(
  nodes: ServerNode[],
  onFinished?: (summary: TestAllSummary) => void,
  /** The REALITY ML-KEM retry (serverTests.ts); none when omitted. */
  mlkem?: MlkemRetry,
): ServerTests {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const nodesRef = useRef(nodeById);
  const finishedRef = useRef(onFinished);
  const mlkemRef = useRef(mlkem);
  useEffect(() => {
    nodesRef.current = nodeById;
    finishedRef.current = onFinished;
    mlkemRef.current = mlkem;
  });

  const controllerRef = useRef<ServerTestsController | null>(null);
  controllerRef.current ??= new ServerTestsController(
    {
      probeServers: (options) => NexusCore.probeServers(options),
      cancelProbe: (options) => NexusCore.cancelProbe(options),
      tcpPing: (options) => NexusCore.tcpPing(options),
      onProbe: (handler) => coreEvents.subscribe('serverProbe', handler),
      onProbeDone: (handler) => coreEvents.subscribe('serverProbeDone', handler),
    },
    (id) => nodesRef.current.get(id),
    render,
    (summary) => finishedRef.current?.(summary),
    {
      variant: (node) => mlkemRef.current?.variant(node) ?? null,
      verdict: (node, needed) => mlkemRef.current?.verdict(node, needed),
    },
  );
  const controller = controllerRef.current;

  useEffect(() => {
    controller.attach();
    return () => controller.dispose();
  }, [controller]);

  return {
    tcp: controller.tcp,
    delay: controller.delay,
    progress: controller.progress,
    start: controller.start,
    cancel: controller.cancel,
    recordLive: controller.recordLive,
  };
}
