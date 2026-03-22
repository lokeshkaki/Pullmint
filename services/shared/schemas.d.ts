import { z } from 'zod';
export declare const SignalSchema: z.ZodObject<{
    signalType: z.ZodEnum<{
        "production.error_rate": "production.error_rate";
        "production.latency": "production.latency";
        "deployment.status": "deployment.status";
        "ci.coverage": "ci.coverage";
        "ci.result": "ci.result";
        time_of_day: "time_of_day";
        author_history: "author_history";
        simultaneous_deploy: "simultaneous_deploy";
    }>;
    value: z.ZodUnion<readonly [z.ZodNumber, z.ZodBoolean]>;
    source: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export declare const CheckpointRecordSchema: z.ZodObject<{
    type: z.ZodEnum<{
        analysis: "analysis";
        "pre-deploy": "pre-deploy";
        "post-deploy-5": "post-deploy-5";
        "post-deploy-30": "post-deploy-30";
    }>;
    score: z.ZodNumber;
    confidence: z.ZodNumber;
    missingSignals: z.ZodArray<z.ZodString>;
    signals: z.ZodArray<z.ZodObject<{
        signalType: z.ZodEnum<{
            "production.error_rate": "production.error_rate";
            "production.latency": "production.latency";
            "deployment.status": "deployment.status";
            "ci.coverage": "ci.coverage";
            "ci.result": "ci.result";
            time_of_day: "time_of_day";
            author_history: "author_history";
            simultaneous_deploy: "simultaneous_deploy";
        }>;
        value: z.ZodUnion<readonly [z.ZodNumber, z.ZodBoolean]>;
        source: z.ZodString;
        timestamp: z.ZodNumber;
    }, z.core.$strip>>;
    decision: z.ZodEnum<{
        approved: "approved";
        held: "held";
        rollback: "rollback";
    }>;
    reason: z.ZodString;
    confirmedWithLowConfidence: z.ZodOptional<z.ZodBoolean>;
    evaluatedAt: z.ZodNumber;
}, z.core.$strip>;
export declare const FindingSchema: z.ZodObject<{
    type: z.ZodEnum<{
        architecture: "architecture";
        security: "security";
        performance: "performance";
        style: "style";
    }>;
    severity: z.ZodEnum<{
        info: "info";
        critical: "critical";
        high: "high";
        medium: "medium";
        low: "low";
    }>;
    title: z.ZodString;
    description: z.ZodString;
    file: z.ZodOptional<z.ZodString>;
    line: z.ZodOptional<z.ZodNumber>;
    suggestion: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RepoContextSchema: z.ZodObject<{
    isSharedDependency: z.ZodBoolean;
    downstreamDependentCount: z.ZodNumber;
    blastRadiusMultiplier: z.ZodNumber;
    repoRollbackRate30d: z.ZodNumber;
    simultaneousDeploysInProgress: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const PRExecutionSchema: z.ZodObject<{
    executionId: z.ZodString;
    repoFullName: z.ZodString;
    repoPrKey: z.ZodOptional<z.ZodString>;
    prNumber: z.ZodNumber;
    headSha: z.ZodString;
    baseSha: z.ZodOptional<z.ZodString>;
    orgId: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    author: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        pending: "pending";
        analyzing: "analyzing";
        completed: "completed";
        failed: "failed";
        deploying: "deploying";
        deployed: "deployed";
        "deployment-blocked": "deployment-blocked";
        monitoring: "monitoring";
        confirmed: "confirmed";
        "rolled-back": "rolled-back";
    }>;
    timestamp: z.ZodOptional<z.ZodNumber>;
    entityType: z.ZodOptional<z.ZodLiteral<"execution">>;
    findings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            architecture: "architecture";
            security: "security";
            performance: "performance";
            style: "style";
        }>;
        severity: z.ZodEnum<{
            info: "info";
            critical: "critical";
            high: "high";
            medium: "medium";
            low: "low";
        }>;
        title: z.ZodString;
        description: z.ZodString;
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
        suggestion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    riskScore: z.ZodOptional<z.ZodNumber>;
    confidenceScore: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodOptional<z.ZodNumber>;
    deploymentStatus: z.ZodOptional<z.ZodEnum<{
        failed: "failed";
        deploying: "deploying";
        deployed: "deployed";
    }>>;
    deploymentEnvironment: z.ZodOptional<z.ZodString>;
    deploymentStrategy: z.ZodOptional<z.ZodEnum<{
        deployment: "deployment";
        eventbridge: "eventbridge";
        label: "label";
    }>>;
    deploymentMessage: z.ZodOptional<z.ZodString>;
    deploymentApprovedAt: z.ZodOptional<z.ZodNumber>;
    deploymentStartedAt: z.ZodOptional<z.ZodNumber>;
    deploymentCompletedAt: z.ZodOptional<z.ZodNumber>;
    rollbackStatus: z.ZodOptional<z.ZodEnum<{
        failed: "failed";
        triggered: "triggered";
        "not-configured": "not-configured";
    }>>;
    checkpoints: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            analysis: "analysis";
            "pre-deploy": "pre-deploy";
            "post-deploy-5": "post-deploy-5";
            "post-deploy-30": "post-deploy-30";
        }>;
        score: z.ZodNumber;
        confidence: z.ZodNumber;
        missingSignals: z.ZodArray<z.ZodString>;
        signals: z.ZodArray<z.ZodObject<{
            signalType: z.ZodEnum<{
                "production.error_rate": "production.error_rate";
                "production.latency": "production.latency";
                "deployment.status": "deployment.status";
                "ci.coverage": "ci.coverage";
                "ci.result": "ci.result";
                time_of_day: "time_of_day";
                author_history: "author_history";
                simultaneous_deploy: "simultaneous_deploy";
            }>;
            value: z.ZodUnion<readonly [z.ZodNumber, z.ZodBoolean]>;
            source: z.ZodString;
            timestamp: z.ZodNumber;
        }, z.core.$strip>>;
        decision: z.ZodEnum<{
            approved: "approved";
            held: "held";
            rollback: "rollback";
        }>;
        reason: z.ZodString;
        confirmedWithLowConfidence: z.ZodOptional<z.ZodBoolean>;
        evaluatedAt: z.ZodNumber;
    }, z.core.$strip>>>;
    signalsReceived: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    repoContext: z.ZodOptional<z.ZodObject<{
        isSharedDependency: z.ZodBoolean;
        downstreamDependentCount: z.ZodNumber;
        blastRadiusMultiplier: z.ZodNumber;
        repoRollbackRate30d: z.ZodNumber;
        simultaneousDeploysInProgress: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    calibrationApplied: z.ZodOptional<z.ZodNumber>;
    overrideHistory: z.ZodOptional<z.ZodArray<z.ZodObject<{
        justification: z.ZodOptional<z.ZodString>;
        overriddenAt: z.ZodNumber;
        executionId: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const FileMetricsSchema: z.ZodObject<{
    repoFullName: z.ZodString;
    filePath: z.ZodString;
    churnRate30d: z.ZodNumber;
    churnRate90d: z.ZodNumber;
    bugFixCommitCount30d: z.ZodNumber;
    ownerLogins: z.ZodArray<z.ZodString>;
    lastModifiedSha: z.ZodString;
}, z.core.$strip>;
export declare const AuthorProfileSchema: z.ZodObject<{
    repoFullName: z.ZodString;
    authorLogin: z.ZodString;
    rollbackRate: z.ZodNumber;
    mergeCount30d: z.ZodNumber;
    avgRiskScore: z.ZodNumber;
    frequentFiles: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export declare const ModuleNarrativeSchema: z.ZodObject<{
    repoFullName: z.ZodString;
    modulePath: z.ZodString;
    narrativeText: z.ZodString;
    generatedAtSha: z.ZodString;
    version: z.ZodNumber;
    embedding: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
}, z.core.$strip>;
export declare const RepoRegistryRecordSchema: z.ZodObject<{
    repoFullName: z.ZodString;
    indexingStatus: z.ZodEnum<{
        pending: "pending";
        failed: "failed";
        indexing: "indexing";
        indexed: "indexed";
    }>;
    contextVersion: z.ZodNumber;
    pendingBatches: z.ZodNumber;
    queuedExecutionIds: z.ZodArray<z.ZodString>;
    lastError: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CalibrationRecordSchema: z.ZodObject<{
    repoFullName: z.ZodString;
    observationsCount: z.ZodNumber;
    successCount: z.ZodNumber;
    rollbackCount: z.ZodNumber;
    falsePositiveCount: z.ZodNumber;
    falseNegativeCount: z.ZodNumber;
    calibrationFactor: z.ZodNumber;
    lastUpdatedAt: z.ZodNumber;
}, z.core.$strip>;
export declare const AnalysisCacheRecordSchema: z.ZodObject<{
    cacheKey: z.ZodString;
    findings: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            architecture: "architecture";
            security: "security";
            performance: "performance";
            style: "style";
        }>;
        severity: z.ZodEnum<{
            info: "info";
            critical: "critical";
            high: "high";
            medium: "medium";
            low: "low";
        }>;
        title: z.ZodString;
        description: z.ZodString;
        file: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
        suggestion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    riskScore: z.ZodNumber;
    contextQuality: z.ZodOptional<z.ZodEnum<{
        full: "full";
        partial: "partial";
        none: "none";
    }>>;
    ttl: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ValidatedPRExecution = z.infer<typeof PRExecutionSchema>;
export type ValidatedCheckpointRecord = z.infer<typeof CheckpointRecordSchema>;
export type ValidatedFileMetrics = z.infer<typeof FileMetricsSchema>;
export type ValidatedAuthorProfile = z.infer<typeof AuthorProfileSchema>;
export type ValidatedModuleNarrative = z.infer<typeof ModuleNarrativeSchema>;
export type ValidatedRepoRegistryRecord = z.infer<typeof RepoRegistryRecordSchema>;
export type ValidatedCalibrationRecord = z.infer<typeof CalibrationRecordSchema>;
export type ValidatedAnalysisCacheRecord = z.infer<typeof AnalysisCacheRecordSchema>;
//# sourceMappingURL=schemas.d.ts.map