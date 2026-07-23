import { Command } from 'commander'
import { siblingCheckIdentityCommand } from './sibling-check-identity.js'
import { siblingCreateCommand } from './sibling-create.js'

export const siblingCommand = new Command('sibling').description(
  'Create and manage sibling apps that share a Biffo core project (ADR-0007)',
)

siblingCommand.addCommand(siblingCreateCommand)
siblingCommand.addCommand(siblingCheckIdentityCommand)
