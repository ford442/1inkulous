/// <reference lib="webworker" />
/**
 * The simulation core's own thread. Everything it does is in host.ts; this is
 * only the worker's end of the channel.
 */
import { serveCore, type HostPort } from './host'

serveCore(self as unknown as HostPort)
