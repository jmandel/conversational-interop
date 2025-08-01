// Conversation Orchestrator and REST API

import { v4 as uuidv4 } from 'uuid';
import { ConversationDatabase } from '../db/database.js';
import { createAgent } from '$agents/factory.js';
import { createClient } from '$client/index.js';
import type { LLMProvider } from 'src/types/llm.types.js';
import { ToolSynthesisService } from '../../agents/services/tool-synthesis.service.js';
import type { AgentId, AgentInterface } from '$lib/types.js';
import {
  Conversation, ConversationTurn, TraceEntry, AgentConfig,
  CreateConversationRequest, CreateConversationResponse,
  ConversationEvent, TurnShell, OrchestratorConversationState,
  UserQueryRequest, UserQueryResponse, StartTurnRequest, StartTurnResponse, AddTraceEntryRequest,
  CompleteTurnRequest, SubscriptionOptions, ThoughtEntry,
  ToolCallEntry, ScenarioDrivenAgentConfig, FormattedUserQuery, UserQueryRow,
  ScenarioConfiguration
} from '$lib/types.js';

interface InProgressTurnState {
  turnId: string;
  conversationId: string;
  agentId: string;
  startedAt: Date;
}

export class ConversationOrchestrator {
  private db: ConversationDatabase;
  private eventListeners: Map<string, Map<string, Set<(event: ConversationEvent) => void>>>;
  private activeConversations: Map<string, OrchestratorConversationState>;
  private inProgressTurns: Map<string, InProgressTurnState>;
  private llmProvider: LLMProvider;
  private toolSynthesisService: ToolSynthesisService;

  constructor(
    dbPath?: string,
    llmProvider?: LLMProvider,
    toolSynthesisService?: ToolSynthesisService
  ) {
    this.db = new ConversationDatabase(dbPath);
    this.eventListeners = new Map();
    this.activeConversations = new Map();
    this.inProgressTurns = new Map();
    
    // LLM provider is now required - no more fallback to default
    if (!llmProvider) {
      throw new Error('LLM provider must be provided to ConversationOrchestrator');
    }
    
    this.llmProvider = llmProvider;
    this.toolSynthesisService = toolSynthesisService || new ToolSynthesisService(this.llmProvider);
  }

  // ============= Core Methods =============

  async createConversation(request: CreateConversationRequest): Promise<CreateConversationResponse> {
    const conversationId = uuidv4();
    const agentTokens: Record<string, string> = {};
    const managementMode = request.managementMode || 'internal';


    // Create conversation with enriched metadata
    const conversation: Conversation = {
      id: conversationId,
      name: request.name,
      createdAt: new Date(),
      agents: request.agents.map(a => a.agentId),
      turns: [],
      status: 'created', // Start in created state
      metadata: {
        agentConfigs: request.agents,
        managementMode,
        ...(request.initiatingAgentId && { initiatingAgentId: request.initiatingAgentId }),
      }
    };

    this.db.createConversation(conversation);

    // Create tokens for each agent after conversation is created
    for (const config of request.agents) {
      const token = this.generateToken();
      agentTokens[config.agentId.id] = token;
      this.db.createAgentToken(token, conversationId, config.agentId.id);
    }

    // Initialize conversation state (but don't start agents yet)
    this.activeConversations.set(conversationId, {
      conversation,
      agentConfigs: new Map(request.agents.map(a => [a.agentId.id, a])),
      agentTokens
    });

    console.log(`[Orchestrator] Conversation ${conversationId} created in '${managementMode}' mode with ${request.agents.length} agents`);

    // Emit conversation created event - this happens for ALL conversations regardless of management mode
    this.emitEvent(conversationId, {
      type: 'conversation_created',
      conversationId,
      timestamp: new Date(),
      data: {
        conversation: {
          id: conversation.id,
          name: conversation.name,
          managementMode,
          agents: conversation.agents,
          status: conversation.status,
          createdAt: conversation.createdAt
        }
      }
    });

    return { conversation, agentTokens };
  }

  async startConversation(conversationId: string): Promise<void> {
    // Fetch the conversation from the database
    const conversation = this.db.getConversation(conversationId, false, false);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Guard clause: Check if conversation is in 'internal' management mode
    const managementMode = conversation.metadata?.managementMode;
    if (managementMode !== 'internal') {
      throw new Error(`Cannot start an externally managed conversation. Management mode: ${managementMode}`);
    }

    // Guard clause: Check if conversation status is 'created'
    if (conversation.status !== 'created') {
      throw new Error(`Conversation has already been started. Current status: ${conversation.status}`);
    }

    // Update the conversation status to 'active' in the database
    this.db.updateConversationStatus(conversationId, 'active');

    // Get conversation state with agent configs
    const conversationState = this.activeConversations.get(conversationId);
    if (!conversationState) {
      throw new Error(`Conversation ${conversationId} not found in active conversations`);
    }

    // Update in-memory state
    conversationState.conversation.status = 'active';

    // Execute the agent provisioning logic
    console.log(`[Orchestrator] Starting conversation ${conversationId}, provisioning ${conversationState.agentConfigs.size} agents`);
    
    for (const [agentId, agentConfig] of conversationState.agentConfigs) {
      try {
        console.log(`[Orchestrator] Creating ${agentConfig.strategyType} agent: ${agentConfig.agentId.label}`);
        
        let scenarioForAgent: ScenarioConfiguration | undefined = undefined;

        if (agentConfig.strategyType === 'scenario_driven') {
          const scenarioConfig = agentConfig as ScenarioDrivenAgentConfig;
          const loadedScenario = this.db.findScenarioByIdAndVersion(scenarioConfig.scenarioId, scenarioConfig.scenarioVersionId);
          
          if (!loadedScenario) {
            console.error(`[Orchestrator] CRITICAL: Failed to load scenario ${scenarioConfig.scenarioId} for agent ${agentConfig.agentId.label}. Skipping agent.`);
            continue; // Skip provisioning this agent
          }
          scenarioForAgent = loadedScenario;
        }
        
        const client = createClient('in-process', this);
        const agent = createAgent(
          agentConfig, 
          client,
          { // Pass the new dependencies object
            db: this.db,
            llmProvider: this.llmProvider,
            toolSynthesisService: this.toolSynthesisService,
            scenario: scenarioForAgent // Pass the pre-loaded scenario
          }
        );
        
        // Get the token for this agent
        const token = this.getAgentToken(conversationId, agentId);
        console.log(`[Orchestrator] Initializing agent ${agentConfig.agentId.label} with token`);
        
        // Store agent reference for cleanup
        if (!conversationState.agents) {
          conversationState.agents = new Map();
        }
        conversationState.agents.set(agentId, agent);
        
        // Initialize agent synchronously to avoid race conditions
        await this.initializeAgentAsync(agent, conversationId, token);
        
        console.log(`[Orchestrator] Agent ${agentConfig.agentId.label} provisioned successfully`);
        
      } catch (error) {
        console.error(`[Orchestrator] Failed to provision agent ${agentConfig.agentId.label}:`, error);
      }
    }
    
    console.log(`[Orchestrator] All agents provisioned for conversation ${conversationId}`);

    // Emit conversation ready event for agents that need it
    this.emitEvent(conversationId, {
      type: 'conversation_ready',
      conversationId,
      timestamp: new Date(),
      data: {}
    });

    // Handle initial message from metadata
    const initiatingAgentId = conversation.metadata?.initiatingAgentId as AgentId['id'];
    if (initiatingAgentId) {
      const agentConfig = conversationState.agentConfigs.get(initiatingAgentId);
      
      if (agentConfig && agentConfig.messageToUseWhenInitiatingConversation) {
        console.log(`[Orchestrator] Triggering initial agent ${initiatingAgentId} to start conversation.`);
        
        // Find the initiating agent instance
        const initiatingAgent = conversationState.agents?.get(initiatingAgentId);
        if (initiatingAgent) {
          // Trigger the agent to initialize the conversation
          try {
            await initiatingAgent.initializeConversation();
          } catch (error) {
            console.error(`[Orchestrator] Failed to trigger initial agent:`, error);
          }
        } else {
          console.error(`[Orchestrator] Could not find agent instance for initiatingAgentId: ${initiatingAgentId}`);
        }
      }
    }
  }

  private getAgentToken(conversationId: string, agentId: string): string {
    const conversationState = this.activeConversations.get(conversationId);
    if (!conversationState) {
      throw new Error(`Conversation ${conversationId} not found in active conversations`);
    }
    
    const token = conversationState.agentTokens[agentId];
    if (!token) {
      throw new Error(`Token not found for agent ${agentId} in conversation ${conversationId}`);
    }
    
    return token;
  }

  private async initializeAgentAsync(agent: AgentInterface, conversationId: string, token: string) {
    try {
      await agent.initialize(conversationId, token);
      console.log(`[Orchestrator] Agent ${agent.agentId.label} initialized and ready`);
      
      // Subscribe to conversation events
      this.subscribeToConversation(conversationId, (event) => {
        agent.onConversationEvent(event);
      });
      
      console.log(`[Orchestrator] Agent ${agent.agentId.label} subscribed to conversation events`);
    } catch (error) {
      console.error(`[Orchestrator] Failed to initialize agent ${agent.agentId.label}:`, error);
    }
  }

  startTurn(request: StartTurnRequest): StartTurnResponse {
    const turnId = uuidv4();
    
    // Check if this is an external conversation that needs to be activated
    const conversation = this.db.getConversation(request.conversationId, false, false);
    if (conversation && conversation.status === 'created' && conversation.metadata?.managementMode === 'external') {
      console.log(`[Orchestrator] External conversation ${request.conversationId} being activated by first turn from agent ${request.agentId}`);

      // TODO-JCM: we should not double-set state -- we should have changes flow to all places automatically instead of setting  in db and in active convesrations instead of setting  in db and in active convesrations
      // Transition to active status for external conversations on first turn
      this.db.updateConversationStatus(request.conversationId, 'active');
      
      // Update in-memory state if it exists
      const conversationState = this.activeConversations.get(request.conversationId);
      if (conversationState) {
        conversationState.conversation.status = 'active';
      }
    }
    
    // TODO-JCM: we should not double-set state -- we should have changes flow to all places automatically instead of setting  in db and in active convesrations instead of setting  in db and in active convesrations
    // Create in-progress turn in database
    this.db.startTurn(turnId, request.conversationId, request.agentId, request.metadata);

    // Track in-progress turn
    this.inProgressTurns.set(turnId, {
      turnId,
      conversationId: request.conversationId,
      agentId: request.agentId,
      startedAt: new Date()
    });

    // Get the in-progress turn as ConversationTurn structure for the event
    const turnForEvent: ConversationTurn = {
      id: turnId,
      conversationId: request.conversationId,
      agentId: request.agentId,
      timestamp: new Date(),
      content: '', // Will be filled when turn is completed
      metadata: request.metadata,
      status: 'in_progress',
      startedAt: new Date(),
      trace: [] // Start with empty trace
    };

    // Emit event with full turn object
    this.emitEvent(request.conversationId, {
      type: 'turn_started',
      conversationId: request.conversationId,
      timestamp: new Date(),
      data: { turn: turnForEvent }
    });

    return { turnId };
  }

  addTraceEntry(request: AddTraceEntryRequest): void {
    const entry: TraceEntry = {
      ...request.entry,
      id: uuidv4(),
      agentId: request.agentId,
      timestamp: new Date()
    } as TraceEntry;

    // Add to database with turn ID
    this.db.addTraceEntry(request.conversationId, entry, request.turnId);

    // Emit specific events based on trace type
    if (entry.type === 'thought') {
      this.emitEvent(request.conversationId, {
        type: 'agent_thinking',
        conversationId: request.conversationId,
        timestamp: new Date(),
        data: {
          agentId: request.agentId,
          thought: (entry as ThoughtEntry).content
        }
      });
    } else if (entry.type === 'tool_call') {
      this.emitEvent(request.conversationId, {
        type: 'tool_executing',
        conversationId: request.conversationId,
        timestamp: new Date(),
        data: {
          agentId: request.agentId,
          toolName: (entry as ToolCallEntry).toolName,
          parameters: (entry as ToolCallEntry).parameters
        }
      });
    }

    // Get turn shell (turn without trace array) for efficient event payload
    const inProgressTurn = this.inProgressTurns.get(request.turnId);
    
    // If turn is not in progress, try to get it from database
    let turnShell: TurnShell;
    if (inProgressTurn) {
      turnShell = {
        id: request.turnId,
        conversationId: request.conversationId,
        agentId: request.agentId,
        timestamp: inProgressTurn.startedAt,
        content: '', // Will be filled when turn is completed
        metadata: undefined,
        status: 'in_progress',
        startedAt: inProgressTurn.startedAt,
        isFinalTurn: false
      };
    } else {
      // Turn might be completed, get it from database (without trace to create shell)
      const completedTurn = this.db.getTurn(request.turnId);
      if (!completedTurn) {
        throw new Error(`Turn ${request.turnId} not found for trace entry`);
      }
      
      turnShell = {
        id: completedTurn.id,
        conversationId: completedTurn.conversationId,
        agentId: completedTurn.agentId,
        timestamp: completedTurn.timestamp,
        content: completedTurn.content,
        metadata: completedTurn.metadata,
        status: completedTurn.status,
        startedAt: completedTurn.startedAt,
        completedAt: completedTurn.completedAt,
        isFinalTurn: completedTurn.isFinalTurn
      };
    }

    // Emit general trace added event with turn shell and specific trace entry
    this.emitEvent(request.conversationId, {
      type: 'trace_added',
      conversationId: request.conversationId,
      timestamp: new Date(),
      data: { turn: turnShell, trace: entry }
    });
  }

  completeTurn(request: CompleteTurnRequest): ConversationTurn {
    const inProgress = this.inProgressTurns.get(request.turnId);
    if (!inProgress) {
      throw new Error(`Turn ${request.turnId} not found or already completed`);
    }

    // Complete turn in database
    this.db.completeTurn(request.turnId, request.content, request.isFinalTurn);

    // Get trace entries for the turn
    const trace = this.db.getTraceEntriesForTurn(request.turnId);

    // Create completed turn object
    const turn: ConversationTurn = {
      id: request.turnId,
      conversationId: request.conversationId,
      agentId: request.agentId,
      timestamp: new Date(),
      content: request.content,
      metadata: request.metadata,
      status: 'completed',
      startedAt: inProgress.startedAt,
      completedAt: new Date(),
      trace, // Include trace data
      isFinalTurn: request.isFinalTurn || false
    };

    // Update in-memory state
    const state = this.activeConversations.get(request.conversationId);
    if (state) {
      state.conversation.turns.push(turn);
    }

    // Clean up in-progress tracking
    this.inProgressTurns.delete(request.turnId);

    // Emit turn completed event with full turn object
    this.emitEvent(request.conversationId, {
      type: 'turn_completed',
      conversationId: request.conversationId,
      timestamp: new Date(),
      data: { turn } // Full turn object with trace included
    });


    return turn;
  }


  createUserQuery(request: UserQueryRequest): string {
    const queryId = uuidv4();
    
    this.db.createUserQuery({
      id: queryId,
      conversationId: request.conversationId,
      agentId: request.agentId,
      question: request.question,
      context: request.context
    });

    // Emit event with full query object
    this.emitEvent(request.conversationId, {
      type: 'user_query_created',
      conversationId: request.conversationId,
      timestamp: new Date(),
      data: {
        query: {
          queryId,
          agentId: request.agentId,
          question: request.question,
          context: request.context || {},
          createdAt: new Date(),
          timeout: 300000 // 5 minutes default
        }
      }
    });

    return queryId;
  }

  respondToUserQuery(queryId: string, response: string): void {
    const query = this.db.getUserQuery(queryId);
    if (!query) {
      throw new Error(`Query ${queryId} not found`);
    }

    this.db.updateUserQueryResponse(queryId, response);
    
    // Emit event
    this.emitEvent(query.conversation_id, {
      type: 'user_query_answered',
      conversationId: query.conversation_id,
      timestamp: new Date(),
      data: {
        queryId,
        response,
        context: query.context ? JSON.parse(query.context) : {}
      }
    });
  }

  getUserQueryStatus(queryId: string): UserQueryResponse {
    const query = this.db.getUserQuery(queryId);
    if (!query) {
      throw new Error(`Query ${queryId} not found`);
    }

    return {
      queryId,
      status: query.status as any,
      response: query.response || undefined
    };
  }

  getConversation(conversationId: string, includeTurns = true, includeTrace = false, includeInProgress = false): any {
    const conversation = this.db.getConversation(conversationId, includeTurns, includeTrace);
    if (!conversation) return null;

    const result: any = { ...conversation };

    if (includeInProgress) {
      const inProgressTurns = this.db.getInProgressTurns(conversationId);
      if (inProgressTurns.length > 0) {
        result.inProgressTurns = {};
        for (const turn of inProgressTurns) {
          result.inProgressTurns[turn.agentId] = {
            id: turn.id,
            conversationId: turn.conversationId,
            agentId: turn.agentId,
            startedAt: turn.startedAt,
            metadata: turn.metadata
          };
        }
      }
    }

    return result;
  }

  getAllConversations(options?: { 
    limit?: number; 
    offset?: number; 
    includeTurns?: boolean; 
    includeTrace?: boolean;
  }): { conversations: any[]; total: number; limit: number; offset: number } {
    const result = this.db.getAllConversations(options);
    return {
      ...result,
      limit: options?.limit || 50,
      offset: options?.offset || 0
    };
  }

  endConversation(conversationId: string): void {
    this.db.updateConversationStatus(conversationId, 'completed');
    
    const event: ConversationEvent = {
      type: 'conversation_ended',
      conversationId,
      timestamp: new Date(),
      data: {}
    };

    this.notifyAllAgents(conversationId, event);
    this.activeConversations.delete(conversationId);
  }

  // ============= Event Management =============
  
  private globalEventListeners: Map<string, (event: ConversationEvent) => void> = new Map();

  private subscribeToAllConversations(
    callback: (event: ConversationEvent) => void,
    options?: SubscriptionOptions
  ): () => void {
    const subscriptionId = uuidv4();
    
    // Create filtered callback if options provided
    const filteredCallback = options 
      ? (event: ConversationEvent) => {
          // Filter by event type
          if (options.events && !options.events.includes(event.type)) {
            return;
          }
          
          // Filter by agent
          if (options.agents) {
            const agentId = this.getAgentIdFromEvent(event);
            if (agentId && !options.agents.includes(agentId)) {
              return;
            }
          }
          
          callback(event);
        }
      : callback;

    this.globalEventListeners.set(subscriptionId, filteredCallback);

    // Return unsubscribe function
    return () => {
      this.globalEventListeners.delete(subscriptionId);
    };
  }

  subscribeToConversation(
    conversationId: string, 
    callback: (event: ConversationEvent) => void,
    options?: SubscriptionOptions
  ): () => void {
    // Special case for global subscription to all conversations
    if (conversationId === '*') {
      return this.subscribeToAllConversations(callback, options);
    }

    if (!this.eventListeners.has(conversationId)) {
      this.eventListeners.set(conversationId, new Map());
    }

    const conversationListeners = this.eventListeners.get(conversationId)!;
    const subscriptionId = uuidv4();
    
    // Create filtered callback if options provided
    const filteredCallback = options 
      ? (event: ConversationEvent) => {
          // Filter by event type
          if (options.events && !options.events.includes(event.type)) {
            return;
          }
          
          // Filter by agent
          if (options.agents) {
            const agentId = this.getAgentIdFromEvent(event);
            if (agentId && !options.agents.includes(agentId)) {
              return;
            }
          }
          
          callback(event);
        }
      : callback;

    if (!conversationListeners.has(subscriptionId)) {
      conversationListeners.set(subscriptionId, new Set());
    }
    conversationListeners.get(subscriptionId)!.add(filteredCallback);

    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(conversationId);
      if (listeners) {
        listeners.delete(subscriptionId);
        if (listeners.size === 0) {
          this.eventListeners.delete(conversationId);
        }
      }
    };
  }

  private getAgentIdFromEvent(event: ConversationEvent): string | null {
    switch (event.type) {
      case 'turn_started':
        return event.data.turn?.agentId;
      case 'trace_added':
        return event.data.turn?.agentId || event.data.agentId; // Support both new and old formats
      case 'agent_thinking':
      case 'tool_executing':
        return event.data.agentId;
      case 'user_query_created':
        return event.data.query?.agentId || event.data.agentId; // Support both new and old formats
      case 'turn_completed':
        return event.data.turn?.agentId || event.data.agentId;
      default:
        return null;
    }
  }

  private emitEvent(conversationId: string, event: ConversationEvent): void {
    // Notify conversation-specific listeners
    const conversationListeners = this.eventListeners.get(conversationId);
    if (conversationListeners) {
      conversationListeners.forEach(listeners => {
        listeners.forEach(callback => callback(event));
      });
    }
    
    // Notify global listeners
    this.globalEventListeners.forEach(callback => callback(event));
    
    // Log for debugging
    console.log(`Event emitted for ${conversationId}:`, event.type, event.data);
  }

  private notifyAgent(conversationId: string, event: ConversationEvent): void {
    this.emitEvent(conversationId, event);
  }

  private notifyAllAgents(conversationId: string, event: ConversationEvent): void {
    this.emitEvent(conversationId, event);
  }

  // ============= Utility Methods =============

  private generateToken(): string {
    return uuidv4().replace(/-/g, '');
  }

  validateAgentToken(token: string): { conversationId: string; agentId: string } | null {
    return this.db.validateToken(token);
  }

  cleanup(): void {
    this.db.cleanupExpiredTokens();
  }

  cancelTurn(turnId: string): void {
    const inProgress = this.inProgressTurns.get(turnId);
    if (!inProgress) {
      throw new Error(`Turn ${turnId} not found or already completed`);
    }

    // Update status to cancelled
    this.db.updateTurnStatus(turnId, 'cancelled');
    
    // Clean up
    this.inProgressTurns.delete(turnId);

    // Emit cancellation event
    this.emitEvent(inProgress.conversationId, {
      type: 'turn_cancelled',
      conversationId: inProgress.conversationId,
      timestamp: new Date(),
      data: { turnId, agentId: inProgress.agentId }
    });
  }

  // Additional query methods for API endpoints
    /**
   * Get pending user queries for a specific conversation
   * @param conversationId - Conversation to check for pending queries
   * @returns Formatted query objects ready for API consumption
   */
  getPendingUserQueries(conversationId: string): FormattedUserQuery[] {
    const queries = this.db.getPendingUserQueries(conversationId);
    return queries.map(this.formatUserQuery);
  }

  /**
   * Get all pending user queries across the system
   * @returns All pending queries formatted for API consumption
   */
  getAllPendingUserQueries(): FormattedUserQuery[] {
    const queries = this.db.getAllPendingUserQueries();
    return queries.map(this.formatUserQuery);
  }

  /**
   * Format raw database query row into API-friendly object
   */
  private formatUserQuery = (q: UserQueryRow): FormattedUserQuery => {
    return {
      queryId: q.id,
      conversationId: q.conversation_id,
      agentId: q.agent_id,
      question: q.question,
      context: q.context ? JSON.parse(q.context) : {},
      createdAt: q.created_at,
      status: q.status as 'pending' | 'answered' | 'expired',
      timeout: 300000 // Default timeout 5 minutes
    };
  }

  getDbInstance(): ConversationDatabase {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

