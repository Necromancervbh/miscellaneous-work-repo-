import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  FC,
  PropsWithChildren,
} from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, BarChart, Bar } from "recharts";
import LRUCache from "lru-cache";

/**
 * Types
 */
interface Anomaly {
  id: string;
  timestamp: number; // epoch ms
  severity: number; // 0..1
  description: string;
}

interface MetricSample {
  timestamp: number; // epoch ms
  value: number;
}

/**
 * Props for the Dashboard component.
 * - wsUrl: WebSocket endpoint of the orchestrator.
 * - jwtToken: JWT used for authentication.
 * - cacheSize: maximum number of recent anomalies to keep in cache.
 */
interface DashboardProps {
  wsUrl: string;
  jwtToken: string;
  cacheSize?: number;
}

/**
 * Helper: validates a URL string.
 */
function isValidUrl(url: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper: validates a JWT (basic structure check).
 */
function isValidJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Dashboard component.
 */
export const Dashboard: FC<PropsWithChildren<DashboardProps>> = ({
  wsUrl,
  jwtToken,
  cacheSize = 100,
}) => {
  // Input validation
  if (!isValidUrl(wsUrl)) {
    throw new Error("Invalid WebSocket URL");
  }
  if (!isValidJwt(jwtToken)) {
    throw new Error("Invalid JWT token");
  }

  // State
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [metrics, setMetrics] = useState<MetricSample[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isUnmountedRef = useRef(false);

  // LRU cache for recent anomalies
  const anomalyCache = useRef(
    new LRUCache<string, Anomaly>({
      max: cacheSize,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    })
  );

  /**
   * Process incoming WebSocket messages.
   */
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "anomaly") {
          const anomaly: Anomaly = {
            id: data.id,
            timestamp: data.timestamp,
            severity: data.severity,
            description: data.description,
          };
          anomalyCache.current.set(anomaly.id, anomaly);
          // Update state with cache contents (preserve order by timestamp descending)
          const cached = Array.from(anomalyCache.current.values())
            .sort((a, b) => b.timestamp - a.timestamp);
          setAnomalies(cached);
        } else if (data.type === "metrics") {
          const sample: MetricSample = {
            timestamp: data.timestamp,
            value: data.value,
          };
          setMetrics((prev) => {
            const updated = [...prev, sample];
            // Keep only last 500 samples to limit memory usage
            return updated.length > 500 ? updated.slice(updated.length - 500) : updated;
          });
        } else {
          console.warn("Unknown message type:", data.type);
        }
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    },
    []
  );

  /**
   * Establish WebSocket connection with authentication.
   */
  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const url = new URL(wsUrl);
    // Append JWT as query param for initial auth (alternatively use subprotocols or headers)
    url.searchParams.append("token", jwtToken);

    const ws = new WebSocket(url.toString());

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnectionError(null);
      // Optionally send a handshake message
      ws.send(JSON.stringify({ action: "subscribe", topics: ["anomalies", "metrics"] }));
    };

    ws.onmessage = handleMessage;

    ws.onerror = (ev) => {
      console.error("WebSocket error:", ev);
    };

    ws.onclose = (event) => {
      if (isUnmountedRef.current) return;
      const shouldReconnect = !event.wasClean;
      if (shouldReconnect) {
        const delay = Math.min(10000, 1000 * 2 ** reconnectAttemptsRef.current);
        reconnectAttemptsRef.current += 1;
        setTimeout(() => {
          if (!isUnmountedRef.current) {
            connectWebSocket();
          }
        }, delay);
      } else {
        setConnectionError("WebSocket connection closed.");
      }
    };

    wsRef.current = ws;
  }, [wsUrl, jwtToken, handleMessage]);

  // Effect: start connection on mount, cleanup on unmount
  useEffect(() => {
    isUnmountedRef.current = false;
    connectWebSocket();

    return () => {
      isUnmountedRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectWebSocket]);

  /**
   * Compute KPI values from metrics.
   * Example KPI: moving average over the last N samples.
   *
   * Formula:
   *   MA_N = ( Σ_{i=1}^{N} value_i ) / N
   */
  const computeMovingAverage = (samples: MetricSample[], windowSize: number): number => {
    if (samples.length === 0) return 0;
    const relevant = samples.slice(-windowSize);
    const sum = relevant.reduce((acc, cur) => acc + cur.value, 0);
    return sum / relevant.length;
  };

  const movingAvg = computeMovingAverage(metrics, 30); // 30-sample moving average

  // Render KPI chart (line chart of metric values) and anomaly list
  return (
    <div style={{ padding: "1rem", fontFamily: "Arial, sans-serif" }}>
      <h2>Real‑Time Anomaly Detection Dashboard</h2>

      {connectionError && (
        <div style={{ color: "red", marginBottom: "1rem" }}>
          Connection error: {connectionError}
        </div>
      )}

      <section style={{ marginBottom: "2rem" }}>
        <h3>KPI: Moving Average (last 30 samples) = {movingAvg.toFixed(2)}</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={metrics}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              domain={["auto", "auto"]}
              tickFormatter={(ts) => new Date(ts).toLocaleTimeString()}
            />
            <YAxis />
            <Tooltip
              labelFormatter={(ts) => new Date(ts).toLocaleString()}
            />
            <Line type="monotone" dataKey="value" stroke="#8884d8" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section>
        <h3>Recent Anomalies (most recent {anomalies.length})</h3>
        {anomalies.length === 0 ? (
          <p>No anomalies reported.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={anomalies.map(a => ({
              timestamp: a.timestamp,
              severity: a.se