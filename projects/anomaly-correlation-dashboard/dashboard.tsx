import React, { useEffect, useState, useRef, useCallback } from "react";
import axios, { AxiosError } from "axios";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Snackbar,
  Alert,
  Typography,
} from "@mui/material";
import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import KMeans from "ml-kmeans";

/**
 * Types
 */
interface Anomaly {
  id: string;
  timestamp: string; // ISO string
  value: number;
  featureX: number;
  featureY: number;
  // Additional fields can be added as needed
}

interface ClusteredAnomaly extends Anomaly {
  cluster: number;
}

/**
 * Constants
 */
const ORCHESTRATOR_API_URL = "/api/anomalies";
const ALERT_API_URL = "/api/alerts";
const WEBSOCKET_URL = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws/anomalies";

/**
 * Dashboard Component
 */
const Dashboard: React.FC = () => {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [clusteredData, setClusteredData] = useState<ClusteredAnomaly[]>([]);
  const [k, setK] = useState<number>(3);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [alertMsg, setAlertMsg] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const isMounted = useRef<boolean>(true);

  /**
   * Fetch initial anomalies from orchestrator API
   */
  const fetchAnomalies = useCallback(async () => {
    setLoading(true);
    try {
      const response = await axios.get<Anomaly[]>(ORCHESTRATOR_API_URL);
      if (Array.isArray(response.data)) {
        setAnomalies(response.data);
      } else {
        throw new Error("Invalid data format received from API");
      }
    } catch (error) {
      const msg = (error as AxiosError).isAxiosError
        ? `API Error: ${(error as AxiosError).message}`
        : `Unexpected Error: ${(error as Error).message}`;
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Run K-Means clustering on anomalies
   * Uses featureX and featureY as 2‑dimensional vectors.
   * Formula: minimize Σ_i Σ_{x∈C_i} ||x - μ_i||²
   */
  const runClustering = useCallback(() => {
    if (anomalies.length === 0) {
      setClusteredData([]);
      return;
    }

    const dataMatrix = anomalies.map((a) => [a.featureX, a.featureY]);

    // Validate k (must be >=1 and <= number of points)
    const effectiveK = Math.max(1, Math.min(k, anomalies.length));

    try {
      const result = KMeans(dataMatrix, effectiveK);
      const clustered: ClusteredAnomaly[] = anomalies.map((a, idx) => ({
        ...a,
        cluster: result.clusters[idx],
      }));
      setClusteredData(clustered);
    } catch (e) {
      setErrorMsg(`Clustering failed: ${(e as Error).message}`);
    }
  }, [anomalies, k]);

  /**
   * WebSocket handling for live updates
   */
  const initWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const ws = new WebSocket(WEBSOCKET_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.info("WebSocket connection opened");
    };

    ws.onmessage = (event) => {
      try {
        const payload: Anomaly = JSON.parse(event.data);
        // Basic validation
        if (!payload.id || typeof payload.featureX !== "number" || typeof payload.featureY !== "number") {
          console.warn("Invalid anomaly payload received via WebSocket");
          return;
        }
        setAnomalies((prev) => {
          const updated = [...prev, payload];
          // Keep only latest 500 points to avoid memory blow‑up
          return updated.length > 500 ? updated.slice(updated.length - 500) : updated;
        });
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };

    ws.onerror = (event) => {
      console.error("WebSocket error:", event);
      setErrorMsg("WebSocket connection error");
    };

    ws.onclose = (event) => {
      console.info(`WebSocket closed (code=${event.code})`);
      // Attempt reconnection after a delay
      if (isMounted.current) {
        setTimeout(initWebSocket, 5000);
      }
    };
  }, []);

  /**
   * Trigger alert for a specific anomaly
   */
  const triggerAlert = async (anomalyId: string) => {
    try {
      await axios.post(ALERT_API_URL, { anomalyId });
      setAlertMsg(`Alert sent for anomaly ${anomalyId}`);
    } catch (error) {
      const msg = (error as AxiosError).isAxiosError
        ? `Alert API error: ${(error as AxiosError).message}`
        : `Unexpected error: ${(error as Error).message}`;
      setErrorMsg(msg);
    }
  };

  /**
   * Effect: component mount/unmount
   */
  useEffect(() => {
    isMounted.current = true;
    fetchAnomalies();
    initWebSocket();

    return () => {
      isMounted.current = false;
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [fetchAnomalies, initWebSocket]);

  /**
   * Effect: re‑run clustering when anomalies or k change
   */
  useEffect(() => {
    runClustering();
  }, [anomalies, k, runClustering]);

  /**
   * UI Handlers
   */
  const handleKChange = (event: SelectChangeEvent<number>) => {
    const value = Number(event.target.value);
    if (!Number.isNaN(value) && value > 0) {
      setK(value);
    }
  };

  const handleCloseSnackbar = () => {
    setErrorMsg("");
    setAlertMsg("");
  };

  /**
   * Render
   */
  return (
    <Box sx={{ p: 4 }}>
      <Typography variant="h4" gutterBottom>
        Anomaly Correlation Dashboard
      </Typography>

      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <FormControl sx={{ minWidth: 120, mr: 2 }}>
          <InputLabel id="k-select-label">Clusters (k)</InputLabel>
          <Select
            labelId="k-select-label"
            value={k}
            label="Clusters (k)"
            onChange={handleKChange as any}
          >
            {[2, 3, 4, 5, 6].map((val) => (
              <MenuItem key={val} value={val}>
                {val}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {loading && <CircularProgress size={24} />}
      </Box>

      {clusteredData.length > 0 ? (
        <ResponsiveContainer width="100%" height={500}>
          <ScatterChart>
            <XAxis type="number" dataKey="featureX" name="Feature X" />
            <YAxis type="number" dataKey="featureY" name="Feature Y" />
            <Tooltip