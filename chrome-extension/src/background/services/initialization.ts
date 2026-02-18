import { agentModelStore, llmProviderStore, AgentNameEnum, ProviderTypeEnum } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('Initialization');

/**
 * Service responsible for first-run initialization and default configuration setup
 */
export class InitializationService {
  /**
   * Ensures default configuration is set up on first run
   * Only configures defaults if no providers exist yet
   */
  async ensureDefaultConfiguration(): Promise<void> {
    try {
      // Check if any providers exist - only setup defaults if NO providers configured
      const providers = await llmProviderStore.getAllProviders();
      const hasProviders = Object.keys(providers).length > 0;

      // Only proceed if no providers are configured yet
      if (hasProviders) {
        logger.info('Providers already configured, skipping default setup');
        return;
      }

      // Setup default Replyzy provider
      const replyzyProviderId = 'replyzy';
      // Get backend URL from environment variable, fallback to localhost
      const replyzyBackendUrl = import.meta.env.VITE_REPLYZY_BACKEND || 'http://localhost:7200/';
      logger.info('Setting up default Replyzy provider with backend URL:', replyzyBackendUrl);

      const replyzyProvider = {
        name: 'Replyzy',
        type: ProviderTypeEnum.CustomOpenAI,
        apiKey: '', // Empty - to be added later by user
        baseUrl: replyzyBackendUrl,
        modelNames: ['gpt-5', 'gpt-5-mini'],
        createdAt: Date.now(),
      };

      await llmProviderStore.setProvider(replyzyProviderId, replyzyProvider);
      logger.info('Created default Replyzy provider');

      // Get default parameters for each agent
      const getModelParameters = (agent: AgentNameEnum): Record<string, unknown> => {
        // Default parameters - can be customized per agent if needed
        return { temperature: 0.1, topP: 0.1 };
      };

      // Configure Planner agent with gpt-5-mini and medium reasoning
      const plannerParams = getModelParameters(AgentNameEnum.Planner);
      await agentModelStore.setAgentModel(AgentNameEnum.Planner, {
        provider: replyzyProviderId,
        modelName: 'gpt-5-mini',
        parameters: plannerParams,
        reasoningEffort: 'medium',
      });
      logger.info('Configured default Planner model with gpt-5-mini');

      // Configure Navigator agent with gpt-5-mini and medium reasoning
      const navigatorParams = getModelParameters(AgentNameEnum.Navigator);
      await agentModelStore.setAgentModel(AgentNameEnum.Navigator, {
        provider: replyzyProviderId,
        modelName: 'gpt-5-mini',
        parameters: navigatorParams,
        reasoningEffort: 'medium',
      });
      logger.info('Configured default Navigator model with gpt-5-mini');

      logger.info('Default configuration setup completed successfully');
    } catch (error) {
      logger.error('Failed to create default configuration:', error);
      // Don't throw - allow user to configure manually
    }
  }
}

// Export singleton instance
export const initialization = new InitializationService();
