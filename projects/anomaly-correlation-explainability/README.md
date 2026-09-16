# Anomaly Correlation Explainability Service  
*Category:* Data Science  
*Stack:* Node.js / TypeScript  

---  

## Overview  

The **Anomaly Correlation Explainability Service** (ACES) is a lightweight, server‑side library that turns raw anomaly detections into human‑readable, actionable explanations. By correlating anomalous data points with their most influential features, ACES helps data scientists, ML engineers, and business analysts understand **why** an anomaly occurred, not just **that** it occurred.  

Key benefits:  

- **Interpretability:** Generates natural‑language explanations and feature importance scores.  
- **Extensibility:** Plug‑in friendly – works with any time‑series or tabular anomaly detector.  
- **Performance‑focused:** Built on async Node.js primitives; suitable for real‑time pipelines.  
- **Type‑safe:** Full TypeScript typings guarantee compile‑time safety.  

---  

## Theory & Architecture  

### 1. Detection → Explanation Pipeline  

1. **Anomaly Input** – A JSON payload containing the anomalous observation, its timestamp, and optional metadata.  
2. **Feature Correlation Engine** –  
   - Computes Pearson / Spearman correlation (or user‑supplied similarity metric) between the anomalous point and historical feature vectors.  
   - Ranks features by absolute correlation magnitude.  
3. **Contribution Scorer** –  
   - Applies SHAP‑like additive attribution to estimate each top‑k feature’s contribution to the anomaly score.  
4. **Narrative Generator** –  
   - Templates (e.g., `The spike in **{feature}** by **{Δ%}** drove the anomaly.`) are filled using the scored contributions.  
5. **Response** – Returns a structured object with:  
   - `explanation: string`  
   - `topFeatures: Array<{ name: string; contribution: number; correlation: number }>`  

### 2. Core Modules  

| Module | Responsibility | Key Types |
|--------|----------------|-----------|
| `src/types.ts` | Shared interfaces (`AnomalyPayload`, `ExplanationResult`) | `AnomalyPayload`, `ExplanationResult` |
| `src/correlation.ts` | Correlation calculations (Pearson, Spearman, custom) | `CorrelationFn` |
| `src/scorer.ts` | Contribution scoring (linear, SHAP‑approx) | `ScoreFn` |
| `src/narrative.ts` | Template rendering & localization | `NarrativeTemplate` |
| `src/server.ts` | Express‑style HTTP endpoint (`/explain`) | `RequestHandler` |

### 3. Extensibility Points  

- **Custom Correlation** – Register a new `CorrelationFn` via `registerCorrelation('myMetric', fn)`.  
- **Alternative Scorers** – Plug in a Monte‑Carlo or deep‑learning based attribution method.  
- **Template Packs** – Provide domain‑specific language packs (finance, IoT, health).  

---  

## Quickstart  

### Prerequisites  

- Node.js **≥ 18**  
- npm or Yarn  

```bash
# Clone the repo
git clone https://github.com/your-org/aces.git
cd aces

# Install dependencies
npm install   # or `yarn install`
```

### Running the Service  

```bash
# Build TypeScript sources
npm run build

# Start the HTTP server (default port 3000)
npm start
```

The service now listens on `http://localhost:3000/explain`.

### Code Example – Using the Client Library  

```typescript
import axios from 'axios';

// Example anomalous observation
const payload = {
  timestamp: '2026-09-15T14:23:00Z',
  values: {
    temperature: 98.7,
    pressure: 1.23,
    vibration: 0.87,
    humidity: 45,
  },
  metadata: {
    sensorId: 'sensor-42',
    location: 'Plant A',
  },
};

async function getExplanation() {
  try {
    const response = await axios.post<{
      explanation: string;
      topFeatures: { name: string; contribution: number; correlation: number }[];
    }>('http://localhost:3000/explain', payload);

    console.log('📝 Explanation:', response.data.explanation);
    console.table(response.data.topFeatures);
  } catch (err) {
    console.error('❌ Failed to fetch explanation:', err);
  }
}

getExplanation();
```

**Result (sample)**  

```
📝 Explanation: The sudden rise in temperature by 12% and a 9% drop in pressure together drove the anomaly.
┌─────────┬───────────────┬───────────────┬─────────────┐
│ (index) │    name       │ contribution  │ correlation │
├─────────┼───────────────┼───────────────┼─────────────┤
│    0    │ 'temperature'│   0.68        │   0.91      │
│    1    │ 'pressure'   │   0