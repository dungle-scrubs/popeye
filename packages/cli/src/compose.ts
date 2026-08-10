/**
 * Owns the sole in-process composition boundary between the CLI and kernel.
 * It exists so wire heads remain protocol-only while local hosting has one explicit exception.
 */
import { kernelPackage } from "@peye/kernel";

export const inProcessKernelPackage = kernelPackage;
