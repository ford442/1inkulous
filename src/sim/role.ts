/**
 * What a follower is for. Mirrors inkulous::Role in
 * cpp/include/1inkulous/followers.hpp; the core packs it into the instance
 * flags from bit ROLE_SHIFT up. The shaman is a flag, not a role.
 */
export const Role = {
  brave: 0,
  warrior: 1,
} as const
export type Role = (typeof Role)[keyof typeof Role]

/** Mirrors kRoleShift / kRoleMask. */
export const ROLE_SHIFT = 3
export const ROLE_MASK = 0x7 << ROLE_SHIFT

/** The role packed into an instance's flags float. */
export function roleOfFlags(flags: number): Role {
  return ((flags & ROLE_MASK) >> ROLE_SHIFT) as Role
}
