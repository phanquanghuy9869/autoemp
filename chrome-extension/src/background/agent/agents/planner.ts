import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { z } from 'zod';
import type { AgentOutput } from '../types';
import { HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isForbiddenError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
import { filterExternalContent } from '../messages/utils';
import { log } from 'node:console';
const logger = createLogger('PlannerAgent');

// Define Zod schema for planner output
export const plannerOutputSchema = z.object({
  observation: z.string(),
  challenges: z.string(),
  done: z.union([
    z.boolean(),
    z.string().transform(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      throw new Error('Invalid boolean string');
    }),
  ]),
  next_steps: z.string(),
  final_answer: z.string(),
  reasoning: z.string(),
  web_task: z.union([
    z.boolean(),
    z.string().transform(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      throw new Error('Invalid boolean string');
    }),
  ]),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

// Configuration for server-based planning fallback
export interface PlannerConfig {
  useServerForFirstPlan?: boolean;
  serverPlanEndpoint?: string;
}

export interface PlannerExtraOptions extends ExtraAgentOptions {
  plannerConfig?: PlannerConfig;
}

export class PlannerAgent extends BaseAgent<typeof plannerOutputSchema, PlannerOutput> {
  private readonly plannerConfig?: PlannerConfig;

  constructor(options: BaseAgentOptions, extraOptions?: Partial<PlannerExtraOptions>) {
    super(plannerOutputSchema, options, { ...extraOptions, id: 'planner' });
    this.plannerConfig = extraOptions?.plannerConfig;
  }

  async execute(): Promise<AgentOutput<PlannerOutput>> {
    try {
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...');

      // get all messages from the message manager, state message should be the last one
      const messages = this.context.messageManager.getMessages();
      // Use full message history except the first one
      const plannerMessages = [this.prompt.getSystemMessage(), ...messages.slice(1)];

      // Remove images from last message if vision is not enabled for planner but vision is enabled
      if (!this.context.options.useVisionForPlanner && this.context.options.useVision) {
        const lastStateMessage = plannerMessages[plannerMessages.length - 1];
        let newMsg = '';

        if (Array.isArray(lastStateMessage.content)) {
          for (const msg of lastStateMessage.content) {
            if (msg.type === 'text') {
              newMsg += msg.text;
            }
            // Skip image_url messages
          }
        } else {
          newMsg = lastStateMessage.content;
        }

        plannerMessages[plannerMessages.length - 1] = new HumanMessage(newMsg);
      }

      // Get model output - use server API for first call if configured, otherwise use LLM
      let modelOutput: PlannerOutput | null = null;
      if (
        this.context.nSteps === 0 &&
        this.plannerConfig?.useServerForFirstPlan &&
        this.plannerConfig?.serverPlanEndpoint
      ) {
        logger.info('Using server-based planning for first call');
        try {
          modelOutput = await this.executeWithServerPlan();
        } catch (error) {
          // If server fails, fall back to LLM
          logger.error('Server planning failed: ' + error);
          logger.info('Falling back to LLM-based planning');
          modelOutput = await this.invoke(plannerMessages);
        }
      } else {
        modelOutput = await this.invoke(plannerMessages);
      }

      if (!modelOutput) {
        throw new Error('Failed to validate planner output');
      }

      // clean the model output
      const observation = filterExternalContent(modelOutput.observation);
      const final_answer = filterExternalContent(modelOutput.final_answer);
      const next_steps = filterExternalContent(modelOutput.next_steps);
      const challenges = filterExternalContent(modelOutput.challenges);
      const reasoning = filterExternalContent(modelOutput.reasoning);

      const cleanedPlan: PlannerOutput = {
        ...modelOutput,
        observation,
        challenges,
        reasoning,
        final_answer,
        next_steps,
      };

      // If task is done, emit the final answer; otherwise emit next steps
      const eventMessage = cleanedPlan.done ? cleanedPlan.final_answer : cleanedPlan.next_steps;
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, eventMessage);
      logger.info('Planner output', JSON.stringify(cleanedPlan, null, 2));

      return {
        id: this.id,
        result: cleanedPlan,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      }

      logger.error(`Planning failed: ${errorMessage}`);
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_FAIL, `Planning failed: ${errorMessage}`);
      return {
        id: this.id,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute planning using server API instead of LLM
   */
  private async executeWithServerPlan(): Promise<PlannerOutput> {
    const endpoint = this.plannerConfig?.serverPlanEndpoint;
    if (!endpoint) {
      throw new Error('Server plan endpoint not configured');
    }

    // Construct the API endpoint URL
    const apiUrl = `${endpoint.replace(/\/$/, '')}/planner/ReplyMessage/Facebook`;

    logger.info(`Fetching plan from server: ${apiUrl}`);

    // Make API call to server
    const response = await fetch(apiUrl, {
      method: 'GET',
      signal: this.context.controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }

    const serverPlan = await response.json();

    // Validate and transform server response to PlannerOutput format
    const planOutput = plannerOutputSchema.parse(serverPlan);

    logger.info('Server plan received', JSON.stringify(planOutput, null, 2));

    return planOutput;
  }
}
