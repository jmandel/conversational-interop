// Tool Synthesis Service - Oracle implementation
import type { LLMProvider } from "src/types/llm.types.js";
import type { ScenarioConfiguration, AgentConfiguration, Tool } from "$lib/types.js";

export interface ToolExecutionInput {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  scenario: ScenarioConfiguration;
  conversationHistory: string;
}

export interface ToolExecutionOutput {
  output: unknown;
}

export class ToolSynthesisService {
  constructor(private llm: LLMProvider) {}

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    try {
      // Directly call the LLM synthesis method without caching.
      return await this.synthesizeWithLLM(input);
    } catch (error) {
      console.error(`[Oracle] Tool synthesis failed for ${input.toolName}:`, error);
      return {
        output: {
          error: 'Tool synthesis failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }


  private async synthesizeWithLLM(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const { toolName, args, agentId, scenario, conversationHistory } = input;
    
    const agentConfig = scenario.agents.find(a => a.agentId.id === agentId);
    if (!agentConfig) throw new Error(`Agent '${agentId}' not found.`);
    const tool = agentConfig.tools.find(t => t.toolName === toolName);
    if (!tool) throw new Error(`Tool '${toolName}' not found for agent '${agentId}'.`);

    const prompt = this.buildSynthesisPrompt(tool, args, agentConfig, scenario, conversationHistory);
    
    const response = await this.llm.generateResponse({ 
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7 // Medium temperature for creative work
    });

    const parsed = this.parseOracleResponse(response.content);
    
    console.log(`[Oracle Reasoning for ${input.toolName}]: ${parsed.reasoning}`);
    return { output: parsed.output };
  }

  /**
   * Builds the synthesis prompt for the Oracle LLM
   */
  private buildSynthesisPrompt(
    tool: Tool, 
    args: Record<string, unknown>, 
    agentConfig: AgentConfiguration, 
    scenario: ScenarioConfiguration, 
    conversationHistory: string
  ): string {
    return `You are an omniscient "Oracle" or "World Simulator" for a multi-agent conversation. Your job is to play the part of the external world (EHRs, databases, APIs) and provide realistic tool execution results.

<CONTEXT>
  <SCENARIO_CONTEXT>
    Title: ${scenario.metadata.title}
    Description: ${scenario.metadata.description}
    Background: ${scenario.scenario.background}
    Challenges: ${JSON.stringify(scenario.scenario.challenges, null, 2)}
  </SCENARIO_CONTEXT>

  <CONVERSATION_HISTORY_SO_FAR>
${conversationHistory}
  </CONVERSATION_HISTORY_SO_FAR>

  <CALLING_AGENT_PROFILE>
    Agent: ${agentConfig.agentId.label} (${agentConfig.agentId.id})
    Principal: ${agentConfig.principal.name}
    Role: ${agentConfig.agentId.role}
    Situation: ${agentConfig.situation}
    Goals: ${JSON.stringify(agentConfig.goals, null, 2)}
    Knowledge Base: ${JSON.stringify(agentConfig.knowledgeBase, null, 2)}
  </CALLING_AGENT_PROFILE>

  <OTHER_AGENTS_IN_SCENARIO>
${scenario.agents.filter(a => a.agentId.id !== agentConfig.agentId.id).map(a => `    - ${a.agentId.label} (${a.principal.name}): ${a.principal.description}`).join('\n')}
  </OTHER_AGENTS_IN_SCENARIO>
</CONTEXT>

<TOOL_BEING_EXECUTED>
  <TOOL_NAME>${tool.toolName}</TOOL_NAME>
  <TOOL_DESCRIPTION>${tool.description}</TOOL_DESCRIPTION>
  <DIRECTOR_NOTE_FOR_ORACLE>${tool.synthesisGuidance}</DIRECTOR_NOTE_FOR_ORACLE>
  <ARGUMENTS_PROVIDED>${JSON.stringify(args, null, 2)}</ARGUMENTS_PROVIDED>
</TOOL_BEING_EXECUTED>

<YOUR_TASK>
You are omniscient - you can see ALL agents' knowledge bases and the full scenario context. However, you must only reveal information that would be plausibly knowable by the specific tool being called.

IMPORTANT: The tools are being called by an AI AGENT (shown in CALLING_AGENT_PROFILE), not by a human user directly. The agent is acting on behalf of their principal (the human or organization they represent). Structure your responses appropriately for agent-to-system interactions.

CRITICAL COMMUNICATION CONSTRAINT: In this world, ALL communication between parties happens through the conversation thread between agents. Your tool responses must NEVER:
- Suggest sending emails, faxes, or making phone calls
- Indicate that documents should be submitted through portals, uploaded elsewhere, or sent externally
- Reference any communication channels outside the agent conversation thread
- Imply that the agent should communicate through any means other than the conversation they're already in

Instead, when documents or information need to be shared:
- Indicate that information/documents should be "provided in the conversation"
- Use phrases like "please share in this thread" or "include in your response"
- Treat the conversation as the sole channel for all exchanges

CRITICAL: The knowledge bases and scenario data are just STARTING POINTS and INSPIRATION. You should:
1. EXPAND on the provided information with realistic, detailed data that such a system would actually return
2. Add timestamps, IDs, codes, statuses, and other metadata that real systems include
3. Include realistic variations, edge cases, and details not explicitly mentioned
4. Make the response feel like it came from a real EHR, insurance system, scheduling system, etc.
5. Add plausible details that make the interaction more challenging and realistic
6. Remember you're responding to an AGENT's API call, not a human's direct query

For example:
- If the knowledge base mentions "X-ray negative for fracture", return a full radiology report with technique, findings, impression, radiologist name, accession numbers, etc.
- If it mentions "PT from 6/15-6/27", include specific session notes, progress measurements, therapist observations, CPT codes, units billed, etc.
- If checking coverage, include member ID, group number, deductible amounts, out-of-pocket maximums, specific exclusions, authorization requirements, etc.
- Include appropriate system responses like "Authorized User: Agent patient-agent", "Access logged", "Query timestamp: 2024-07-01T14:23:45Z"

Use the director's note (synthesisGuidance) to understand what character/system to play and how to advance the story. The scenario data is your inspiration, not your script.

Your entire response MUST be a single JSON code block. The JSON object inside MUST have two keys: "reasoning" and "output". The "output" can be any valid JSON type (string, number, object, array). Do not include any other text or explanations outside of the code block.

<EXAMPLE_1>
\`\`\`json
{
  "reasoning": "The user asked for the policy. I am returning the policy object from the agent's knowledgeBase as requested in the synthesis guidance.",
  "output": {
    "policyId": "HF-MRI-KNEE-2024",
    "criteria": [
      "Knee MRI requires >=14 days of documented conservative therapy."
    ]
  }
}
\`\`\`
</EXAMPLE_1>

<EXAMPLE_2>
\`\`\`json
{
  "reasoning": "The synthesis guidance for this tool is to simply return a confirmation string.",
  "output": "Case notes have been successfully created."
}
\`\`\`
</EXAMPLE_2>
</YOUR_TASK>`;
  }

  /**
   * Parses the Oracle's response, gracefully handling common LLM formatting variations.
   */
  private parseOracleResponse(content: string): { reasoning: string; output: unknown } {
    let jsonString: string | null = null;

    // Priority 1: Look for a ```json ... ``` code block.
    const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      jsonString = jsonBlockMatch[1];
    } else {
      // Priority 2: Fallback to a generic ``` ... ``` code block.
      const genericBlockMatch = content.match(/```\s*([\s\S]*?)\s*```/);
      if (genericBlockMatch && genericBlockMatch[1]) {
        jsonString = genericBlockMatch[1];
      } else {
        // Priority 3: Fallback to the first complete bare JSON object `{...}`.
        const bareJsonMatch = content.match(/{\s*[\s\S]*\s*}/);
        if (bareJsonMatch && bareJsonMatch[0]) {
          jsonString = bareJsonMatch[0];
        }
      }
    }

    // If we have a JSON string, try to parse it
    if (jsonString) {
      try {
        const parsedObject = JSON.parse(jsonString);
        if (typeof parsedObject.output === 'undefined' || typeof parsedObject.reasoning === 'undefined') {
          throw new Error("Oracle response JSON is missing required 'output' or 'reasoning' keys.");
        }
        return parsedObject;
      } catch (e) {
        console.error("[Oracle] Failed to parse extracted JSON string:", jsonString);
        // Fall through to fallback heuristic
      }
    }

    // Fallback heuristic: try to find "output" in either the JSON string or raw content
    console.error("[Oracle] Attempting fallback heuristic...");
    const contentToSearch = jsonString || content;
    const outputMatch = contentToSearch.match(/"output"\s*:\s*/);
    if (outputMatch && outputMatch.index !== undefined) {
        const beforeOutput = contentToSearch.substring(0, outputMatch.index);
        const afterOutput = contentToSearch.substring(outputMatch.index + outputMatch[0].length);
        
        // Extract reasoning if present
        let reasoning = "Fallback parsing: no explicit reasoning found";
        const reasoningMatch = beforeOutput.match(/"reasoning"\s*:\s*"([^"]*)"/);
        if (reasoningMatch && reasoningMatch[1]) {
          reasoning = reasoningMatch[1];
        }
        
        // Extract the output value - could be a string, object, array, etc.
        let outputValue: unknown;
        
        // Check if it starts with a quote (string value)
        const trimmedOutput = afterOutput.trim();
        
        // Handle edge case where JSON is truncated right after "output": 
        if (trimmedOutput.length === 0) {
          throw new Error('JSON truncated after output key with no value');
        }
        
        if (trimmedOutput.startsWith('"')) {
          // Find the closing quote, accounting for escaped quotes
          let endIndex = 1;
          let inEscape = false;
          while (endIndex < trimmedOutput.length) {
            if (trimmedOutput[endIndex] === '\\' && !inEscape) {
              inEscape = true;
            } else {
              if (trimmedOutput[endIndex] === '"' && !inEscape) {
                break;
              }
              inEscape = false;
            }
            endIndex++;
          }
          
          // If we didn't find a closing quote, include everything up to end of string
          if (endIndex >= trimmedOutput.length) {
            // The string is unclosed - take everything after the opening quote
            outputValue = trimmedOutput.substring(1);
          } else {
            // Extract the string content (without the quotes)
            outputValue = trimmedOutput.substring(1, endIndex);
            // Unescape the string
            outputValue = outputValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
        } else {
          // For non-string values, we need to find where the value ends
          // This could be at a comma, closing brace, or end of string
          let valueEnd = afterOutput.length;
          let braceDepth = 0;
          let bracketDepth = 0;
          let inString = false;
          let escapeNext = false;
          
          for (let i = 0; i < afterOutput.length; i++) {
            const char = afterOutput[i];
            
            if (escapeNext) {
              escapeNext = false;
              continue;
            }
            
            if (char === '\\') {
              escapeNext = true;
              continue;
            }
            
            if (char === '"') {
              inString = !inString;
              continue;
            }
            
            if (!inString) {
              if (char === '{') braceDepth++;
              else if (char === '}') {
                if (braceDepth === 0) {
                  // This is the closing brace of the main object
                  valueEnd = i;
                  break;
                }
                braceDepth--;
              }
              else if (char === '[') bracketDepth++;
              else if (char === ']') bracketDepth--;
              else if (char === ',' && braceDepth === 0 && bracketDepth === 0) {
                // Found a comma at the top level, this ends the value
                valueEnd = i;
                break;
              }
            }
          }
          
          const valueString = afterOutput.substring(0, valueEnd).trim();
          
          // Try to parse as JSON
          try {
            outputValue = JSON.parse(valueString);
          } catch {
            // If all else fails, treat as string (but this might include trailing commas/braces)
            outputValue = valueString;
          }
        }
        
        console.log("[Oracle] Fallback parsing succeeded");
        return { reasoning, output: outputValue };
    }
    
    throw new Error(`Oracle LLM response was not valid JSON and fallback parsing failed.`);
  }




}