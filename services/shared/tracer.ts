import { Tracer } from '@aws-lambda-powertools/tracer';

export const tracer = new Tracer({ serviceName: 'pullmint' });

export function addTraceAnnotations(annotations: Record<string, string | number>): void {
  const segment = tracer.getSegment();
  if (segment) {
    Object.entries(annotations).forEach(([key, value]) => {
      tracer.putAnnotation(key, String(value));
    });
  }
}
