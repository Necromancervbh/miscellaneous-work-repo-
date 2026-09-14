import { KMeans } from 'ml-kmeans';
import { stl } from 'stl-decomp';
import * as Plotly from 'plotly.js-dist-min';

type Timestamp = string | Date;

interface EvaluationResult {
    metrics: {
        residualMSE: number | null;
        residualMAE: number | null;
        trendMAE: number | null;
        rocAUC: number | null;
        prAUC: number | null;
        precision: number | null;
        recall: number | null;
    };
    chart: Plotly.Config;
}

/**
 * Compute Mean Squared Error.
 * MSE = (1/n) * Σ (e_i)^2
 */
function meanSquaredError(errors: number[]): number {
    if (errors.length === 0) return 0;
    const sumSq = errors.reduce((acc, e) => acc + e * e, 0);
    return sumSq / errors.length;
}

/**
 * Compute Mean Absolute Error.
 * MAE = (1/n) * Σ |e_i|
 */
function meanAbsoluteError(errors: number[]): number {
    if (errors.length === 0) return 0;
    const sumAbs = errors.reduce((acc, e) => acc + Math.abs(e), 0);
    return sumAbs / errors.length;
}

/**
 * Compute ROC curve points and AUC using the trapezoidal rule.
 * @param scores numeric scores (higher means more likely positive)
 * @param labels binary ground truth (true = positive)
 */
function computeRocAuc(scores: number[], labels: boolean[]): { auc: number; precision: number; recall: number } {
    const paired = scores.map((s, i) => ({ score: s, label: labels[i] }));
    paired.sort((a, b) => b.score - a.score); // descending

    let tp = 0;
    let fp = 0;
    const fn = labels.filter(l => l).length;
    const tn = labels.length - fn;

    const tprPoints: number[] = [];
    const fprPoints: number[] = [];

    for (const p of paired) {
        if (p.label) {
            tp++;
        } else {
            fp++;
        }
        const tpr = tp / fn; // recall
        const fpr = fp / tn;
        tprPoints.push(tpr);
        fprPoints.push(fpr);
    }

    // AUC via trapezoidal rule
    let auc = 0;
    for (let i = 1; i < tprPoints.length; i++) {
        const xDiff = fprPoints[i] - fprPoints[i - 1];
        const yAvg = (tprPoints[i] + tprPoints[i - 1]) / 2;
        auc += xDiff * yAvg;
    }

    // Precision and Recall at default threshold 0.5 (or median score)
    const threshold = 0.5;
    let tpThresh = 0;
    let fpThresh = 0;
    let fnThresh = 0;
    for (let i = 0; i < scores.length; i++) {
        const pred = scores[i] >= threshold;
        const actual = labels[i];
        if (pred && actual) tpThresh++;
        else if (pred && !actual) fpThresh++;
        else if (!pred && actual) fnThresh++;
    }
    const precision = tpThresh + fpThresh === 0 ? 0 : tpThresh / (tpThresh + fpThresh);
    const recall = tpThresh + fnThresh === 0 ? 0 : tpThresh / (tpThresh + fnThresh);

    return { auc, precision, recall };
}

/**
 * Compute Precision-Recall curve and AUC using the trapezoidal rule.
 * @param scores numeric scores (higher means more likely positive)
 * @param labels binary ground truth (true = positive)
 */
function computePrAuc(scores: number[], labels: boolean[]): number {
    const paired = scores.map((s, i) => ({ score: s, label: labels[i] }));
    paired.sort((a, b) => b.score - a.score); // descending

    let tp = 0;
    let fp = 0;
    const fn = labels.filter(l => l).length;

    const precisionPoints: number[] = [];
    const recallPoints: number[] = [];

    for (const p of paired) {
        if (p.label) {
            tp++;
        } else {
            fp++;
        }
        const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
        const recall = tp / fn;
        precisionPoints.push(precision);
        recallPoints.push(recall);
    }

    // AUC via trapezoidal rule on recall axis
    let auc = 0;
    for (let i = 1; i < recallPoints.length; i++) {
        const xDiff = recallPoints[i] - recallPoints[i - 1];
        const yAvg = (precisionPoints[i] + precisionPoints[i - 1]) / 2;
        auc += xDiff * yAvg;
    }
    return auc;
}

/**
 * Perform STL decomposition and return the trend component.
 * @param series numeric time‑series
 * @param period seasonal period (e.g., 7 for weekly seasonality)
 */
function extractTrend(series: number[], period: number = 7): number[] {
    // stl returns { trend, seasonal, remainder }
    const result = stl(series, { period, robust: true });
    return result.trend;
}

/**
 * Build a Plotly chart configuration showing actual, forecast, residuals and cluster assignment.
 */
function buildChartConfig(
    timestamps: Timestamp[],
    actual: number[],
    forecast: number[],
    residuals: number[],
    clusterLabels: number[]
):