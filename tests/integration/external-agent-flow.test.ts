// External Agent WebSocket Connection Flow Test
// Tests the full external agent workflow as described in plans/external-agents.md

import { beforeAll, afterAll, beforeEach, afterEach, test, expect, describe } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { HonoWebSocketJsonRpcServer } from '$backend/websocket/hono-websocket-server.js';
import { createLLMProvider } from '$llm/factory.js';
import type { CreateConversationRequest } from '$lib/types.js';
import type { AgentId } from '$lib/types.js';

describe('External Agent Flow Integration', () => {
  let orchestrator: ConversationOrchestrator;
  let wsServer: HonoWebSocketJsonRpcServer;
  let llmProvider: any;

  beforeAll(async () => {
    // Create test LLM provider
    llmProvider = createLLMProvider({
      provider: 'google',
      apiKey: 'test-key',
      model: 'gemini-2.5-flash-lite'
    });

    orchestrator = new ConversationOrchestrator(':memory:', llmProvider);
    wsServer = new HonoWebSocketJsonRpcServer(orchestrator);
  });

  afterAll(() => {
    orchestrator?.close();
    wsServer?.close();
  });

  test('should support external agent workflow', async () => {
    const agentId1: AgentId = { id: 'external-agent-1', label: 'External Agent 1', role: 'responder' };
    const agentId2: AgentId = { id: 'internal-agent-2', label: 'Internal Agent 2', role: 'initiator' };

    // Step 1: Setup Client Creates the Conversation for external management
    const createRequest: CreateConversationRequest = {
      name: 'External Agent Test',
      managementMode: 'external', // This conversation will be managed externally
      agents: [
        { 
          agentId: agentId1, 
          strategyType: 'static_replay',
          script: [
            { trigger: 'hello', response: 'Hello from external agent!' }
          ]
        },
        { 
          agentId: agentId2, 
          strategyType: 'static_replay',
          script: [
            { trigger: 'hello', response: 'Hello back from internal agent!' }
          ]
        }
      ]
    };

    const { conversation, agentTokens } = await orchestrator.createConversation(createRequest);
    
    // Verify conversation is created but not active
    expect(conversation.status).toBe('created');
    expect(conversation.agents).toHaveLength(2);
    expect(agentTokens[agentId1.id]).toBeString();
    expect(agentTokens[agentId2.id]).toBeString();

    // Step 2: Tokens are available for secure distribution
    // The external agent token can now be sent to external process
    const externalAgentToken = agentTokens[agentId1.id];
    const internalAgentToken = agentTokens[agentId2.id];

    expect(externalAgentToken).toBeDefined();
    expect(internalAgentToken).toBeDefined();

    // Step 3: For external conversations, they become active when first agent sends a turn
    // The conversation should still be in 'created' state until first turn
    expect(conversation.status).toBe('created');

    // Step 4: Simulate external agent sending first turn to activate conversation
    // In practice, external agents would use WebSocket to send turns
    // For this test, we'll use the orchestrator directly to simulate the first turn
    const turnId = orchestrator.startTurn({
      conversationId: conversation.id,
      agentId: agentId1.id
    }).turnId;

    // Complete the turn to activate the conversation
    orchestrator.completeTurn({
      conversationId: conversation.id,
      turnId,
      agentId: agentId1.id,
      content: 'Hello from external agent'
    });

    // Conversation should now be active
    const updatedConversation = orchestrator.getConversation(conversation.id);
    expect(updatedConversation!.status).toBe('active');

    // Step 4: Verify token validation works for external agents
    const tokenValidation = orchestrator.validateAgentToken(externalAgentToken);
    expect(tokenValidation).not.toBeNull();
    expect(tokenValidation!.conversationId).toBe(conversation.id);
    expect(tokenValidation!.agentId).toBe(agentId1.id);

    // Step 5: Test conversation state
    // The conversation should be ready for external agent connections
    const agentIds = updatedConversation!.agents.map((a: any) => a.id);
    expect(agentIds).toContain(agentId1.id);
    expect(agentIds).toContain(agentId2.id);
  });

  test('should validate external agent tokens correctly', async () => {
    const agentId: AgentId = { id: 'test-external', label: 'Test External', role: 'test' };

    const createRequest: CreateConversationRequest = {
      name: 'Token Test',
      agents: [
        { 
          agentId, 
          strategyType: 'external_proxy',
          externalId: 'test-service'
        }
      ]
    };

    const { conversation, agentTokens } = await orchestrator.createConversation(createRequest);
    const token = agentTokens[agentId.id];

    // Valid token should validate correctly
    const validation = orchestrator.validateAgentToken(token);
    expect(validation).not.toBeNull();
    expect(validation!.conversationId).toBe(conversation.id);
    expect(validation!.agentId).toBe(agentId.id);

    // Invalid token should return null
    const invalidValidation = orchestrator.validateAgentToken('invalid-token');
    expect(invalidValidation).toBeNull();
  });

  test('should support conversation state transitions', async () => {
    const agentId: AgentId = { id: 'state-test', label: 'State Test', role: 'test' };

    const createRequest: CreateConversationRequest = {
      name: 'State Transition Test',
      managementMode: 'internal', // Use internal mode for this test
      agents: [
        { 
          agentId, 
          strategyType: 'static_replay',
          script: [{ trigger: 'test', response: 'response' }]
        }
      ]
    };

    // 1. Create conversation - should be 'created'
    const { conversation } = await orchestrator.createConversation(createRequest);
    expect(conversation.status).toBe('created');

    // 2. Start conversation - should become 'active'
    await orchestrator.startConversation(conversation.id);
    const activeConversation = orchestrator.getConversation(conversation.id);
    expect(activeConversation!.status).toBe('active');

    // 3. End conversation - should become 'completed'
    orchestrator.endConversation(conversation.id);
    const completedConversation = orchestrator.getConversation(conversation.id);
    expect(completedConversation!.status).toBe('completed');
  });
});