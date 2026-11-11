/** POC 的极简 GraphQL 客户端，只用 fetch，不引入 Apollo。 */

export function endpoint(): string {
	return process.env.POC_URL ?? "http://127.0.0.1:4123/graphql";
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: { message: string }[];
}

export async function gql<T>(
	query: string,
	variables: Record<string, unknown> = {},
): Promise<T> {
	const response = await fetch(endpoint(), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const payload = (await response.json()) as GraphQLResponse<T>;
	if (payload.errors?.length) {
		throw new Error(payload.errors.map((error) => error.message).join("; "));
	}
	return payload.data as T;
}

export interface TaskRow {
	id: string;
	prompt: string;
	status: string;
}

export interface StageRow {
	id: string;
	taskId: string;
	index: number;
	role: string;
	status: string;
	owner: string | null;
	version: number;
	output: string | null;
}

export const STAGES_QUERY = /* GraphQL */ `
	query Stages($taskId: ID!) {
		stages(taskId: $taskId) {
			id
			taskId
			index
			role
			status
			owner
			version
			output
		}
	}
`;
