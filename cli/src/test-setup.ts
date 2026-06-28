import 'aws-sdk-client-mock-vitest/extend'
import {
  toHaveReceivedCommand,
  toHaveReceivedCommandWith,
  toHaveReceivedNthCommandWith,
} from 'aws-sdk-client-mock-vitest'
import { expect } from 'vitest'

expect.extend({ toHaveReceivedCommand, toHaveReceivedCommandWith, toHaveReceivedNthCommandWith })
