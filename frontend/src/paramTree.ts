import { ParamDescriptor } from './api'
import { buildNamespaceTree, countLeaves, TreeNode } from './namespaceTree'

export type ParamTreeNode = TreeNode<ParamDescriptor>

export function buildParamTree(params: ParamDescriptor[]): ParamTreeNode[] {
  return buildNamespaceTree(params, (p) => p.name, '.')
}

export const countParams = countLeaves
