import IndeRunContracts

/// A provenance for tests that need one to build a terminal outcome: one successful
/// cloud attempt, no fallback.
func sampleProvenance(providerId: String = "openai:gpt-5.2") -> ExecutionProvenance {
    ExecutionProvenance(
        attemptCount: 1,
        attempts: [ExecutionProvenanceAttempt(errorClass: nil, outcome: .succeeded, providerId: providerId)],
        configuredModel: "gpt-5.2",
        fallbackOccurred: false,
        locality: .cloud,
        modelProfile: "auto",
        providerId: providerId,
        reportedModel: nil,
        routeRejections: [],
        schemaVersion: .the10
    )
}
