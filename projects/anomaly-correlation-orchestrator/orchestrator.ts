import { Queue, QueueScheduler, Worker, Job, QueueEvents, JobsOptions } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import { randomUUID } from 'crypto';

/**
 * Enum representing the type of a task in the DAG.
 */
export enum TaskType {
  ANALYTICS = 'analytics',
  PREDICTION = 'prediction',
  ALERT = 'alert',
}

/**
 * Interface describing a generic task.
 */
export interface Task {
  /** Unique identifier for the task */
  id: string;
  /** Type of the task */
  type: TaskType;
  /** Arbitrary payload required for execution */
  payload: any;
  /** List of task IDs that must complete before this task runs */
  dependencies?: string[];
}

/**
 * Helper class for Bayesian aggregation of anomaly scores.
 *
 * Posterior probability P(A|E) = (P(A) * Π_i L_i) /
 *   (P(A) * Π_i L_i + (1 - P(A)) * Π_i (1 - L_i))
 *
 * where:
 *   - P(A) is the prior probability (default 0.5)
 *   - L_i are the likelihoods (individual anomaly scores in [0,1])
 */
export class BayesianAggregator {
  /**
   * Aggregates a list of anomaly scores into a single posterior probability.
   *
   * @param scores Array of anomaly scores (each between 0 and 1)
   * @param prior Prior probability (default 0.5)
   * @returns Posterior probability in [0,1]
   */
  static aggregate(scores: number[], prior: number = 0.5): number {
    if (!Array.isArray(scores) || scores.length === 0) {
      throw new Error('Scores array must contain at least one element.');
    }
    if (prior < 0 || prior > 1) {
      throw new Error('Prior must be between 0 and 1.');
    }

    const epsilon = 1e-12; // avoid division by zero
    const prodLikelihood = scores.reduce((acc, s) => acc * Math.min(Math.max(s, epsilon), 1 - epsilon), 1);
    const prodNegLikelihood = scores.reduce((acc, s) => acc * Math.min(Math.max(1 - s, epsilon), 1 - epsilon), 1);

    const numerator = prior * prodLikelihood;
    const denominator = numerator + (1 - prior) * prodNegLikelihood;

    return denominator === 0 ? 0 : numerator / denominator;
  }
}

/**
 * Orchestrator builds a DAG of tasks, enqueues them using BullMQ,
 * processes them, stores intermediate results, and finally aggregates
 * Bayesian anomaly scores.
 */
export class Orchestrator {
  private readonly connection: IORedis;
  private readonly queue: Queue;
  private readonly queueScheduler: QueueScheduler;
  private readonly worker: Worker;
  private readonly queueEvents: QueueEvents;
  private readonly resultHashKey = 'task:results';
  private readonly pendingJobs: Map<string, Job>;

  /**
   * Constructs an Orchestrator.
   *
   * @param redisOptions Options for connecting to Redis.
   * @param queueName   Name of the BullMQ queue (default: 'anomaly-orchestrator')
   */
  constructor(redisOptions: RedisOptions, queueName: string = 'anomaly-orchestrator') {
    this.connection = new IORedis(redisOptions);
    this.queue = new Queue(queueName, { connection: this.connection });
    this.queueScheduler = new QueueScheduler(queueName, { connection: this.connection });
    this.queueEvents = new QueueEvents(queueName, { connection: this.connection });
    this.pendingJobs = new Map();

    // Worker processes each job based on its type.
    this.worker = new Worker(
      queueName,
      async (job: Job) => this.processJob(job),
      {
        connection: this.connection,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
    });
  }

  /**
   * Adds a collection of tasks to the queue, respecting dependencies.
   *
   * @param tasks Array of Task objects.
   */
  async addTasks(tasks: Task[]): Promise<void> {
    this.validateTasks(tasks);
    const sorted = this.topologicalSort(tasks);
    const idToJobId = new Map<string, string>();

    for (const task of sorted) {