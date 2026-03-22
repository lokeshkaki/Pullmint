/* eslint-disable @typescript-eslint/no-require-imports */

let initialized = false;

type OTelNodeSdkModule = typeof import('@opentelemetry/sdk-node');
type OTelAutoInstrumentationsModule = typeof import('@opentelemetry/auto-instrumentations-node');
type OTelHttpExporterModule = typeof import('@opentelemetry/exporter-trace-otlp-http');
type OTelApiModule = typeof import('@opentelemetry/api');

export function initTracing(serviceName: string): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || initialized) {
    return;
  }

  try {
    // Dynamic import keeps OTEL optional when tracing is disabled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node') as OTelNodeSdkModule;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getNodeAutoInstrumentations } =
      require('@opentelemetry/auto-instrumentations-node') as OTelAutoInstrumentationsModule;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OTLPTraceExporter } =
      require('@opentelemetry/exporter-trace-otlp-http') as OTelHttpExporterModule;

    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations()],
    });

    sdk.start();
    initialized = true;
  } catch (error) {
    console.warn('Failed to initialize OpenTelemetry tracing:', error);
  }
}

export function addTraceAnnotations(annotations: Record<string, string | number>): void {
  if (!initialized) {
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trace } = require('@opentelemetry/api') as OTelApiModule;
    const span = trace.getActiveSpan();

    if (span) {
      for (const [key, value] of Object.entries(annotations)) {
        span.setAttribute(key, value);
      }
    }
  } catch {
    // No-op when OTEL runtime is unavailable.
  }
}
