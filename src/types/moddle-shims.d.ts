/**
 * bpmn-moddle and dmn-moddle ship generated TS types for the BPMN/DMN
 * element model (their `/types` subpath), but not for the moddle runtime
 * class itself (`fromXML`/`toXML`) on their main export. This is a minimal
 * ambient shim for just what this project calls - moddle elements
 * themselves are treated as `any` throughout the renderers that use these,
 * same as walking a parsed-XML tree would be.
 */
declare module "bpmn-moddle" {
  export interface ModdleParseResult {
    rootElement: any;
    references: unknown[];
    warnings: unknown[];
    elementsById: Record<string, any>;
  }

  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>, options?: unknown);
    fromXML(xml: string, typeName?: string, options?: unknown): Promise<ModdleParseResult>;
    toXML(element: any, options?: unknown): Promise<{ xml: string }>;
  }
}

declare module "dmn-moddle" {
  export interface ModdleParseResult {
    rootElement: any;
    references: unknown[];
    warnings: unknown[];
    elementsById: Record<string, any>;
  }

  export class DmnModdle {
    constructor(packages?: Record<string, unknown>, options?: unknown);
    fromXML(xml: string, typeName?: string, options?: unknown): Promise<ModdleParseResult>;
    toXML(element: any, options?: unknown): Promise<{ xml: string }>;
  }
}
