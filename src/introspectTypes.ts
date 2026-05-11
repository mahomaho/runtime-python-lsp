export type IntrospectKind =
    | 'class'
    | 'method'
    | 'function'
    | 'builtin'
    | 'callable'
    | 'attribute';

export interface IntrospectParam {
    name: string;
    kind: string;
    default: string | null;
    has_default: boolean;
    annotation: string | null;
}

export interface IntrospectItem {
    name: string;
    kind: IntrospectKind;
    type?: string;
    doc?: string;
    error?: string;
    signature?: string;
    params?: IntrospectParam[];
    return_annotation?: string | null;
}

export interface DescribeResult {
    type: string;
    doc?: string;
    repr?: string;
    signature?: string;
    callable_kind?: string;
    call_result_repr?: string;
    call_result_type?: string;
    call_error?: string;
    qualname?: string;
    module?: string;
    bound_to?: string;
    mro?: string[];
    source_file?: string;
    source_line?: number;
}
