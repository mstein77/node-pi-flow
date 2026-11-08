import Debug from 'debug'
const debug = Debug('tyrolite:http')

interface FetchOptions {
    body?: string
    headers?: Headers
    expectStatus?: number | string | (number | string)[]
    onStatus?: Record<string, (tries: number, response?: Response, options?: FetchOptions) => Promise<boolean | void>>
    signal?: AbortSignal
}

interface FetchJsonResponse {
    status: number,
    headers: Headers,
    body: unknown
}

interface ApiConnection {
    connect: () => Promise<void>,
    disconnect: () => Promise<void>,
    fetchJsonFromPath: (path: string, options?: FetchOptions) => Promise<unknown>
}

interface ApiConfig {
    baseUrl: string
    type: 'rest' | 'socket'
}

const isMatching = (status: string, expectedStatus: string): boolean => {
    if (status === expectedStatus) return true

    const idx = expectedStatus.indexOf('*')
    if (idx === -1) return false

    return idx === 0 || status.startsWith(expectedStatus.slice(0, idx))
}

const fetchJson = async (url: string, options: FetchOptions = {}): Promise<FetchJsonResponse> => {
    const { body, headers = new Headers(), onStatus = {}, expectStatus, ...httpOptions } = options

    const isPost = body !== undefined
    headers.set('Content-type', 'application/json')

    const requestOptions = {
        ...httpOptions,
        method: !isPost ? 'GET' : 'POST',
        body: !isPost ? undefined : (typeof body !== 'string' ? JSON.stringify(body) : body),
        headers
    }
    let tries = 0
    let checkStatus: string[] = []
    let currStatus: string = ''
    let response: Response | undefined
    let repeat = false
    do {
        debug(`Fetching JSON: ${isPost ? 'POST' : 'GET'} ${url}`)
        tries++
        response = await fetch(url, requestOptions)
        checkStatus = Object.keys(onStatus)
        currStatus = `${response.status}`
        repeat = false
        for (const status of checkStatus) {
            if (!isMatching(currStatus, status)) continue

            const handler = onStatus[status]
            if (!handler) continue

            repeat = (await handler(tries, response, requestOptions)) === true
            break
        }
    } while (repeat)

    if (expectStatus) {
        if (Array.isArray(expectStatus)) {
            checkStatus.push(...expectStatus.map(x => `${x}`))
        } else {
            checkStatus.push(`${expectStatus}`)
        }
        let hasMatch = false
        for (const status of checkStatus) {
            if ((status === 'ok' && response.ok) || isMatching(currStatus, status)) {
                hasMatch = true
            }
        }
        if (!hasMatch) {
            throw Error(`Got unexpected http response code ${currStatus}`)
        }
    }
    const json = await response.json()
    if (json === null || typeof json !== 'object') {
        throw Error(``)
    }
    return {
        status: response.status,
        headers: response.headers,
        body: json
    }
}

const createApiConnection = async (config: ApiConfig): Promise<ApiConnection> => {
    let { baseUrl } = config
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1)

    const fetchJsonFromPath = async (path: string, options: FetchOptions = {}) => {
        return fetchJson(`${baseUrl}/${path.startsWith('/') ? path.slice(1) : path}`, options)
    }
    let sessionId: string | null = null

    const connect = async (): Promise<void> => {
        const { headers } = await fetchJsonFromPath('/connect', {
            body: JSON.stringify({}),
            expectStatus: 200
        })
        sessionId = headers.get('x-reqtoken')
        if (!sessionId) {
            throw Error(`Couldn't get session id from response header`)
        }
    }
    return {
        connect,
        disconnect: async (): Promise<void> => {
            sessionId = null
        },
        fetchJsonFromPath: async (path: string, options: FetchOptions = {}): Promise<unknown> => {
            if (!sessionId) {
                await connect()
            }
            const { expectStatus = 200, onStatus = {}, headers = new Headers() } = options
            headers.set('x-reqtoken', sessionId!)
            onStatus[401] = async (tries: number) => {
                if (tries > 1) return false

                await connect()
                if (!sessionId) return false

                headers.set('x-reqtoken', sessionId)
                return true
            }
            const response = await fetchJsonFromPath(
                path,
                {
                    expectStatus,
                    headers,
                    onStatus,
                    ...options
                }
            )
            return response.body
        }
    }
}

export {
    fetchJson,
    createApiConnection,
    ApiConfig,
    ApiConnection
}