import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
    FC,
    MouseEvent,
} from "react";
import {
    ApolloClient,
    InMemoryCache,
    gql,
    NormalizedCacheObject,
    useQuery,
    ApolloProvider,
} from "@apollo/client";
import * as d3 from "d3";

// ---------------------------
// Types
// ---------------------------
interface CorrelationEntry {
    source: string;
    target: string;
    value: number; // correlation coefficient [-1,1]
    timestamp: string; // ISO string
}

interface CorrelationMatrixResponse {
    correlationMatrix: CorrelationEntry[];
}

interface ExplainabilityDetail {
    source: string;
    target: string;
    timestamp: string;
    contribution: number; // contribution score
    description: string;
}

interface ExplainabilityResponse {
    explainability: ExplainabilityDetail[];
}

interface DashboardProps {
    /** ISO 8601 start time for the query window */
    startTime: string;
    /** ISO 8601 end time for the query window */
    endTime: string;
    /** JWT token used for GraphQL auth and WebSocket connection */
    jwtToken: string;
    /** GraphQL endpoint URL (e.g., https://api.example.com/graphql) */
    graphqlEndpoint: string;
    /** WebSocket endpoint URL (e.g., wss://api.example.com/updates) */
    wsEndpoint: string;
}

// ---------------------------
// GraphQL Queries
// ---------------------------
const CORRELATION_MATRIX_QUERY = gql`
    query CorrelationMatrix($start: String!, $end: String!) {
        correlationMatrix(startTime: $start, endTime: $end) {
            source
            target
            value
            timestamp
        }
    }
`;

const EXPLAINABILITY_QUERY = gql`
    query Explainability($source: String!, $target: String!, $timestamp: String!) {
        explainability(source: $source, target: $target, timestamp: $timestamp) {
            source
            target
            timestamp
            contribution
            description
        }
    }
`;

// ---------------------------
// Apollo Client Factory
// ---------------------------
function createApolloClient(
    graphqlEndpoint: string,
    jwtToken: string
): ApolloClient<NormalizedCacheObject> {
    return new ApolloClient({
        uri: graphqlEndpoint,
        cache: new InMemoryCache(),
        headers: {
            Authorization: `Bearer ${jwtToken}`,
        },
    });
}

// ---------------------------
// Dashboard Component
// ---------------------------
export const Dashboard: FC<DashboardProps> = ({
    startTime,
    endTime,
    jwtToken,
    graphqlEndpoint,
    wsEndpoint,
}) => {
    // -----------------------
    // Input Validation
    // -----------------------
    const isValidISODate = (dateStr: string): boolean => {
        const d = new Date(dateStr);
        return !isNaN(d.getTime()) && d.toISOString() === dateStr;
    };

    if (!jwtToken) {
        throw new Error("jwtToken prop is required.");
    }
    if (!isValidISODate(startTime) || !isValidISODate(endTime)) {
        throw new Error("startTime and endTime must be valid ISO 8601 strings.");
    }
    if (new Date(startTime) >= new Date(endTime)) {
        throw new Error("startTime must be earlier than endTime.");
    }

    // -----------------------
    // State Management
    // -----------------------
    const [matrixData, setMatrixData] = useState<CorrelationEntry[]>([]);
    const [selectedDetail, setSelectedDetail] = useState<ExplainabilityDetail | null>(null);
    const [wsError, setWsError] = useState<string | null>(null);
    const [loadingExplain, setLoadingExplain] = useState<boolean>(false);
    const [explainError, setExplainError] = useState<string | null>(null);

    const svgRef = useRef<SVGSVGElement>(null);
    const clientRef = useRef<ApolloClient<NormalizedCacheObject> | null>(null);

    // -----------------------
    // Apollo Client Init
    // -----------------------
    if (!clientRef.current) {
        clientRef.current = createApolloClient(graphqlEndpoint, jwtToken);
    }

    // -----------------------
    // GraphQL Query for Initial Matrix
    // -----------------------
    const {
        loading: loadingMatrix,
        error: matrixError,
        data: matrixQueryData,
        refetch,
    } = useQuery<CorrelationMatrixResponse>(CORRELATION_MATRIX_QUERY, {
        client: clientRef.current,
        variables: { start: startTime, end: endTime },
        fetchPolicy: "network-only",
    });

    // Sync query result to local state
    useEffect(() => {
        if (matrixQueryData && matrixQueryData.correlationMatrix) {
            setMatrixData(matrixQueryData.correlationMatrix);
        }
    }, [matrixQueryData]);

    // -----------------------
    // WebSocket Live Updates
    // -----------------------
    useEffect(() => {
        const wsUrl = `${wsEndpoint}?token=${encodeURIComponent(jwtToken)}`;
        let ws: WebSocket | null = new WebSocket(wsUrl);
        let isMounted = true;

        const handleMessage = (event: MessageEvent) => {
            try {
                const payload = JSON.parse(event.data);
                // Expected payload shape: { type: "CORRELATION_UPDATE", data: CorrelationEntry }
                if (payload.type === "CORRELATION_UPDATE" && payload.data) {
                    const entry: CorrelationEntry = payload.data;
                    if (isMounted) {
                        setMatrixData((prev) => {
                            // Replace existing entry with same source/target/timestamp or append
                            const idx = prev.findIndex(
                                (e) =>
                                    e.source === entry.source &&
                                    e.target === entry.target &&
                                    e.timestamp === entry.timestamp
                            );
                            if (idx >= 0) {
                                const newArr = [...prev];
                                newArr[idx] = entry;
                                return newArr;
                            } else {
                                return [...prev, entry];
                            }
                        });
                    }
                }
            } catch (e) {
                console.error("Failed to parse WebSocket message:", e);
            }
        };

        const handleError = (ev: Event) => {
            console.error("WebSocket error:", ev);
            if (isMounted) setWsError("WebSocket connection error.");
        };

        const handleClose = (ev: CloseEvent) => {
            if (isMounted && !ev.wasClean) {
                console.warn(`WebSocket closed unexpectedly (code=${ev.code}). Reconnecting...`);
                // Simple exponential backoff could be added; for brevity we reconnect after 3s
                setTimeout(() => {
                    if (isMounted) {
                        ws = new WebSocket(wsUrl);
                        ws.addEventListener("message", handleMessage);
                        ws.addEventListener("error", handleError);