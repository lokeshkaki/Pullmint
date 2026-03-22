import { Queue, type QueueOptions } from 'bullmq';
export declare function getQueue(name: string, opts?: Partial<QueueOptions>): Queue;
export declare const QUEUE_NAMES: {
    readonly ANALYSIS: "analysis";
    readonly GITHUB_INTEGRATION: "github-integration";
    readonly DEPLOYMENT: "deployment";
    readonly DEPLOYMENT_STATUS: "deployment-status";
    readonly CALIBRATION: "calibration";
    readonly REPO_INDEXING: "repo-indexing";
    readonly CLEANUP: "cleanup";
};
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export declare function addJob(queueName: QueueName, jobType: string, data: Record<string, unknown>, opts?: {
    jobId?: string;
    delay?: number;
    attempts?: number;
    backoff?: {
        type: 'exponential' | 'fixed';
        delay: number;
    };
}): Promise<void>;
export declare function closeQueues(): Promise<void>;
//# sourceMappingURL=queue.d.ts.map