// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
// ─────────────────────────────────────────────────────────────

import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL ?? 'gpt-4o-mini'

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint) {
                throw new Error('VITE_AI_ENDPOINT is not configured. Set it in .env.local or select mock provider.')
            }

            const messages = []
            if (request.system) {
                messages.push({ role: 'system', content: request.system })
            }
            if (request.history && Array.isArray(request.history)) {
                for (const turn of request.history) {
                    messages.push({ role: turn.role, content: turn.content })
                }
            }
            messages.push({ role: 'user', content: request.user })

            const headers = { 'Content-Type': 'application/json' }
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`
            }

            let response
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature: 0.1
                    })
                })
            } catch (err) {
                throw new Error(`Network failure connecting to AI endpoint: ${err.message}`)
            }

            if (!response.ok) {
                let errBody = ''
                try {
                    errBody = await response.text()
                } catch {
                    errBody = response.statusText
                }

                if (response.status === 401 || response.status === 403) {
                    throw new Error(`AI Provider Authentication Error (${response.status}): Check your VITE_AI_API_KEY in .env.local. Detail: ${errBody}`)
                }
                if (response.status === 429) {
                    throw new Error(`AI Provider Rate Limit Exceeded (429): Too many requests. Detail: ${errBody}`)
                }
                throw new Error(`AI Provider Error (${response.status}): ${errBody}`)
            }

            let data
            try {
                data = await response.json()
            } catch (err) {
                throw new Error(`Invalid JSON response from AI endpoint: ${err.message}`)
            }

            // Extract content from response
            let text = ''
            if (data.choices && data.choices[0]?.message?.content) {
                text = data.choices[0].message.content
            } else if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
                text = data.candidates[0].content.parts[0].text
            } else if (data.content && Array.isArray(data.content) && data.content[0]?.text) {
                text = data.content[0].text
            } else if (typeof data === 'string') {
                text = data
            } else {
                text = JSON.stringify(data)
            }

            return { text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
