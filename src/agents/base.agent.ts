// Transport-Agnostic Base Agent Class

import type { OrchestratorClient } from '$client/index.js';
import {
  AgentConfig,
  AgentId,
  AgentInterface,
  ConversationEvent,
  ConversationTurn,
  ThoughtEntry, ToolCallEntry, ToolResultEntry,
  TurnCompletedEvent,
  TraceEntry
} from '$lib/types.js';
import { v4 as uuidv4 } from 'uuid';

export abstract class BaseAgent implements AgentInterface {
  agentId: AgentId;
  config: AgentConfig;
  protected client: OrchestratorClient;
  protected conversationId?: string;
  protected subscriptionId?: string;
  protected isReady: boolean = false;
  protected conversationEnded = false;

  constructor(config: AgentConfig, client: OrchestratorClient) {
    this.agentId = config.agentId;
    this.config = config;
    this.client = client;

    this.client.on('event', this._handleEvent.bind(this));
  }

  async initialize(conversationId: string, authToken: string): Promise<void> {
    console.log(`Agent ${this.agentId.label} starting initialization...`);
    this.conversationId = conversationId;
    
    await this.client.connect(authToken);
    await this.client.authenticate(authToken);
    
    this.subscriptionId = await this.client.subscribe(conversationId);
    this.isReady = true;
    console.log(`Agent ${this.agentId.label} initialized for conversation ${conversationId} - READY FLAG SET`);
  }

  async shutdown(): Promise<void> {
    this.isReady = false;
    this.conversationEnded = true;
    if (this.subscriptionId) {
      await this.client.unsubscribe(this.subscriptionId);
    }

    this.client.disconnect();
    console.log(`Agent ${this.agentId.label} shutting down`);
  }

  private _handleEvent(event: ConversationEvent, subscriptionId: string) {
    if (subscriptionId === this.subscriptionId) {
      this.onConversationEvent(event);
    }
  }

  async onConversationEvent(event: ConversationEvent): Promise<void> {
    // Don't process events until agent is fully ready
    if (!this.isReady) {
      console.log(`Agent ${this.agentId.label} ignoring ${event.type} - not ready yet`);
      return;
    }
    
    switch (event.type) {
      case 'turn_completed':
        // Agent coordination should use turn_completed (the authoritative completion event)
        await this.onTurnCompleted(event as TurnCompletedEvent);
        break;
      case 'conversation_ended':
        this.isReady = false;
        break;
    }
  }

  // Abstract method for subclasses to implement their core logic
  abstract onTurnCompleted(event: TurnCompletedEvent): Promise<void>;

  // Abstract method for initiating a conversation (no previous turn)
  abstract initializeConversation(): Promise<void>;

  // Abstract method for processing and replying to a turn
  abstract processAndReply(previousTurn: ConversationTurn): Promise<void>;

  // ============= Agent Actions (Delegated to Client) =============

  async startTurn(metadata?: Record<string, any>): Promise<string> {
    return await this.client.startTurn(metadata);
  }

  async addThought(turnId: string, thought: string): Promise<ThoughtEntry> {
    const entry = this.createThought(thought);
    await this.client.addTrace(turnId, { type: 'thought', content: thought });
    return entry;
  }

  async addToolCall(turnId: string, toolName: string, parameters: any): Promise<ToolCallEntry> {
    const toolCallId = uuidv4();
    const entry = this.createToolCall(toolName, parameters);
    entry.toolCallId = toolCallId;
    await this.client.addTrace(turnId, { type: 'tool_call', toolName, parameters, toolCallId });
    return entry;
  }

  async addToolResult(turnId: string, toolCallId: string, result: any, error?: string): Promise<ToolResultEntry> {
    const entry = this.createToolResult(toolCallId, result, error);
    await this.client.addTrace(turnId, { type: 'tool_result', toolCallId, result, error });
    return entry;
  }

  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean): Promise<void> {
    await this.client.completeTurn(turnId, content, isFinalTurn);
  }

  async queryUser(question: string, context?: Record<string, any>): Promise<string> {
    const queryId = await this.client.createUserQuery(question, context);
    
    // Wait for response via events
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('User query timeout'));
      }, 300000); // 5 minutes

      const handleQueryResponse = (event: ConversationEvent) => {
        if (event.type === 'user_query_answered' && event.data.queryId === queryId) {
          clearTimeout(timeout);
          this.client.off('event', handleQueryResponse);
          resolve(event.data.response);
        }
      };

      this.client.on('event', handleQueryResponse);
    });
  }

  // ============= Helper Methods =============

  protected createThought(content: string): ThoughtEntry {
    return {
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'thought',
      content
    };
  }

  protected createToolCall(toolName: string, parameters: Record<string, any>): ToolCallEntry {
    return {
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'tool_call',
      toolName,
      parameters,
      toolCallId: uuidv4()
    };
  }

  protected createToolResult(toolCallId: string, result: any, error?: string): ToolResultEntry {
    return {
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'tool_result',
      toolCallId,
      result,
      error
    };
  }
}