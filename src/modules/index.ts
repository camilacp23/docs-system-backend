/**
 * Registry of module handlers by `operationId` (SDD D-42). Each module adds its operations here when it is
 * built; an operation of the contract without an entry answers 404 NOT_IMPLEMENTED (development only).
 *
 * @module modules
 */
import type { OperationHandlers } from '../http/operations.js';

export const moduleHandlers: OperationHandlers = {};
