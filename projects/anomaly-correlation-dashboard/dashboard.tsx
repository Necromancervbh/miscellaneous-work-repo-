import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  ChangeEvent,
  FC,
} from "react";
import * as d3 from "d3";
import { SimulationNodeDatum, SimulationLinkDatum } from "d3-force";

/**
 * Types representing the graph structure.
 */
interface GraphNode extends SimulationNodeDatum {
  id: string;
  cluster: string;
  /** Optional display label */
  label?: string;
  /** Optional size (radius) */
  size?: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

/**
 * Props for the Dashboard component.
 * In a larger app these could be extended, but for now none are required.
 */
interface DashboardProps {}

/**
 * Helper to safely parse JSON from WebSocket messages.
 */
function safeParse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Main Dashboard component.
 * - Fetches initial graph data via JWT‑protected REST endpoint.
 * - Renders a D3 force‑layout inside an SVG.
 * - Provides a cluster filter UI.
 * - Listens for real‑time updates via WebSocket.
 */
const Dashboard: FC<DashboardProps> = () => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [token, setToken] = useState<string>("");
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>(
    { nodes: [], links: [] }
  );
  const [clusters, setClusters] = useState<Set<string>>(new Set());
  const [selectedCluster, setSelectedCluster] = useState<string>("");

  /**
   * Load JWT token from localStorage (or any other secure store).
   */
  useEffect(() => {
    const stored = localStorage.getItem("jwt_token");
    if (stored && typeof stored === "string") {
      setToken(stored);
    } else {
      console.error("JWT token not found in localStorage");
    }
  }, []);

  /**
   * Fetch initial graph data.
   */
  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();
    const fetchGraph = async () => {
      try {
        const response = await fetch("/api/graph", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        }

        const data = (await response.json()) as {
          nodes: GraphNode[];
          links: GraphLink[];
        };

        // Basic validation
        if (!Array.isArray(data.nodes) || !Array.isArray(data.links)) {
          throw new Error("Invalid graph payload structure");
        }

        // Populate clusters set
        const clusterSet = new Set<string>();
        data.nodes.forEach((n) => {
          if (typeof n.cluster === "string") {
            clusterSet.add(n.cluster);
          }
        });

        setClusters(clusterSet);
        setGraph(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // ignore abort errors
        } else {
          console.error("Failed to fetch graph data:", err);
        }
      }
    };

    fetchGraph();

    return () => controller.abort();
  }, [token]);

  /**
   * Set up WebSocket for real‑time updates.
   */
  useEffect(() => {
    if (!token) return;

    const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${
      window.location.host
    }/ws/graph?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.info("WebSocket connection opened");
    };

    ws.onmessage = (event) => {
      const payload = safeParse<{
        type: "addNode" | "addLink" | "removeNode" | "removeLink";
        data: any;
      }>(event.data);
      if (!payload) {
        console.warn("Received malformed WebSocket message");
        return;
      }

      setGraph((prev) => {
        const nodes = [...prev.nodes];
        const links = [...prev.links];
        switch (payload.type) {
          case "addNode": {
            const node: GraphNode = payload.data;
            if (!node.id) break;
            if (!nodes.find((n) => n.id === node.id)) {
              nodes.push(node);
              if (typeof node.cluster === "string") {
                setClusters((prevSet) => new Set(prevSet).add(node.cluster));
              }
            }
            break;
          }
          case "addLink": {
            const link: GraphLink = payload.data;
            if (!link.source || !link.target) break;
            // Avoid duplicate links
            if (
              !links.find(
                (l) =>
                  (l.source === link.source || (l.source as GraphNode).id === (link.source as GraphNode).id) &&
                  (l.target === link.target || (l.target as GraphNode).id === (link.target as GraphNode).id)
              )
            ) {
              links.push(link);
            }
            break;
          }
          case "removeNode": {
            const nodeId: string = payload.data.id;
            const idx = nodes.findIndex((n) => n.id === nodeId);
            if (idx !== -1) {
              nodes.splice(idx, 1);
              // Remove associated links
              for (let i = links.length - 1; i >= 0; i--) {
                const l = links[i];
                const srcId = typeof l.source === "string" ? l.source : l.source.id;
                const tgtId = typeof l.target === "string" ? l.target : l.target.id;
                if (srcId === nodeId || tgtId === nodeId) {
                  links.splice(i, 1);
                }
              }
            }
            break;
          }
          case "removeLink": {
            const { source, target } = payload.data;
            const idx = links.findIndex(
              (l) =>
                (l.source === source || (l.source as GraphNode).id === source) &&
                (l.target === target || (l.target as GraphNode).id === target)
            );
            if (idx !== -1) {
              links.splice(idx, 1);
            }
            break;
          }
          default:
            console.warn("Unhandled WebSocket message type:", payload.type);
        }
        return { nodes, links };
      });
    };

    ws.onerror = (ev) => {
      console.error("WebSocket error:", ev);
    };

    ws.onclose = (ev) => {
      console.info(`WebSocket closed (code=${ev.code})`);
    };

    return () => {
      ws.close();
    };
  }, [token]);

  /**
   * D3 rendering logic.
   */
  const renderGraph = useCallback(() => {
    const svg = d3.select(svgRef.current);
    if (!svg.node()) return;

    // Clear previous contents
    svg.selectAll("*").remove();

    const