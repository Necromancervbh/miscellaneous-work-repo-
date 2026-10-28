import * as fs from 'fs';

/**
 * Types defining the structure of input data.
 */
export interface CorrelationRecord {
    /** Source feature name */
    source: string;
    /** Target feature name */
    target: string;
    /** Correlation coefficient in range [-1, 1] */
    correlation: number;
}

export interface Evidence {
    /** Feature name -> observed value (true for anomaly, false otherwise) */
    [feature: string]: boolean | number;
}

/**
 * Node representation inside the Bayesian network.
 */
interface BayesNode {
    /** Feature name */
    name: string;
    /** Prior probability P(X) */
    prior: number;
    /** Conditional probability table: parentName -> P(X|parent) */
    cpt: Map<string, number>;
    /** Parents of this node */
    parents: Set<string>;
    /** Children of this node */
    children: Set<string>;
    /** Textual description used for TF‑IDF */
    description: string;
}

/**
 * ExplainabilityEngine builds a Bayesian network from correlation data,
 * computes posterior probabilities given evidence, and produces ranked
 * textual explanations using TF‑IDF of feature descriptions.
 */
export class ExplainabilityEngine {
    private nodes: Map<string, BayesNode> = new Map();
    private evidence: Evidence = {};

    /**
     * Ingest correlation data and optional feature descriptions.
     * @param correlations Array of CorrelationRecord.
     * @param descriptions Map of feature name to textual description.
     * @throws Error if input validation fails.
     */
    public ingestCorrelationData(
        correlations: CorrelationRecord[],
        descriptions: Map<string, string>
    ): void {
        this.validateCorrelations(correlations);
        this.validateDescriptions(descriptions);
        this.buildNetwork(correlations, descriptions);
    }

    /**
     * Set observed evidence for a subset of features.
     * @param ev Evidence object.
     * @throws Error if evidence contains unknown features.
     */
    public setEvidence(ev: Evidence): void {
        for (const feature of Object.keys(ev)) {
            if (!this.nodes.has(feature)) {
                throw new Error(`Evidence contains unknown feature: ${feature}`);
            }
        }
        this.evidence = { ...ev };
    }

    /**
     * Compute posterior probabilities for all nodes using a simple
     * belief propagation algorithm (exact for DAGs).
     * @returns Map of feature name to posterior probability.
     */
    public computePosteriors(): Map<string, number> {
        const order = this.topologicalSort();
        const posteriors = new Map<string, number>();

        for (const nodeName of order) {
            const node = this.nodes.get(nodeName)!;

            // Prior probability P(X)
            let prob = node.prior;

            // Multiply by conditional probabilities given parents' posteriors
            for (const parentName of node.parents) {
                const parentPosterior = posteriors.get(parentName);
                if (parentPosterior === undefined) {
                    throw new Error(`Parent ${parentName} posterior not computed`);
                }
                const condProb = node.cpt.get(parentName);
                if (condProb === undefined) {
                    throw new Error(`Missing CPT entry for ${nodeName} given ${parentName}`);
                }
                // P(X|parent) = condProb, assume binary variables
                prob *= condProb * parentPosterior + (1 - condProb) * (1 - parentPosterior);
            }

            // Incorporate evidence if present (likelihood weighting)
            if (this.evidence.hasOwnProperty(nodeName)) {
                const evVal = this.evidence[nodeName];
                if (typeof evVal === 'boolean') {
                    prob = evVal ? prob : 1 - prob;
                } else if (typeof evVal === 'number') {
                    // Treat numeric evidence as likelihood scaling factor
                    prob = prob * evVal;
                }
            }

            // Clamp probability to [0,1] to avoid numerical issues
            prob = Math.max(0, Math.min(1, prob));
            posteriors.set(nodeName, prob);
        }

        return posteriors;
    }

    /**
     * Generate ranked textual explanations based on TF‑IDF scores of
     * feature descriptions weighted by posterior probabilities.
     * @returns Array of explanations sorted by descending relevance.
     */
    public generateExplanations(): string[] {
        const posteriors = this.computePosteriors();
        const docs = Array.from(this.nodes.values()).map(node => node.description);
        const tfidf = this.computeTfIdf(docs);

        const scores: { node: BayesNode; score: number }[] = [];

        for (const node of this.nodes.values()) {
            const docIndex = Array.from(this.nodes.keys()).indexOf(node.name);
            const tfidfVector = tfidf[docIndex];
            const posterior = posteriors.get(node.name) ?? 0;
            // Score = posterior * sum(TF‑IDF terms)
            const tfidfSum = tfidfVector.reduce((a, b) => a + b, 0);
            const score = posterior * tfidfSum;
            scores.push({ node, score });
        }

        scores.sort((a, b) => b.score - a.score);
        return scores.map(entry => entry.node.description);
    }

    /**
     * Validate correlation records.
     * @param correlations Input array.
     * @throws Error if validation fails.
     */
    private validateCorrelations(correlations: CorrelationRecord[]): void {
        if (!Array.isArray(correlations)) {
            throw new Error('Correlations must be an array');
        }
        for (const rec of correlations) {
            if (typeof rec.source !== 'string' || rec.source.trim() === '') {
                throw new Error('Correlation record missing valid source');
            }
            if (typeof rec.target !== 'string' || rec.target.trim() === '') {
                throw new Error('Correlation record missing valid target');
            }
            if (typeof rec.correlation !== 'number' || rec.correlation < -1 || rec.correlation > 1) {
                throw new Error(`Correlation value for ${rec.source}->${rec.target} out of range [-1,1]`);
            }
        }
    }

    /**
     * Validate feature descriptions.
     * @param descriptions Map of feature name to description.
     * @throws Error if any description is missing or empty.
     */
    private validateDescriptions(descriptions: Map<string, string>): void {
        if (!(descriptions instanceof Map)) {
            throw new Error('Descriptions must be a Map');
        }
        for (const [feature, desc] of descriptions.entries()) {
            if (typeof desc !== 'string' || desc.trim() === '') {
                throw new Error(`Empty description for feature ${feature}`);
            }
        }
    }

    /**
     * Build Bayesian network from correlations and descriptions.
     * Uses a simple heuristic to convert correlation to conditional probability:
     *   P(child|parent) = (1 + correlation) / 2
     *   Prior P(node) = 0.5 (uninformative)
     * @param correlations Correlation data.
     * @param descriptions Feature descriptions.
     */
    private buildNetwork(
        correlations: CorrelationRecord[],
        descriptions: Map<string, string>
    ): void {
        // Initialize nodes
        const allFeatures = new Set<string>();
        for (const rec of correlations) {
            allFeatures.add(rec.source);
            allFeatures.add(rec.target);
        }
        for (const feature of allFeatures) {
            const desc = descriptions.get(feature) ?? `Feature ${feature