import type {
  MasterDataRoot,
  MasterManifest,
} from './masterTypes'

export type MasterValidationIssueCode =
  | 'invalid_manifest'
  | 'invalid_data_version'
  | 'empty_id'
  | 'duplicate_id'
  | 'invalid_sort_order'
  | 'invalid_element_bonus_capability'
  | 'invalid_rank_order'
  | 'missing_reference'
  | 'inactive_reference'
  | 'duplicate_weapon_bonus_definition'
  | 'invalid_artian_bonus_scope'
  | 'duplicate_bonus_type_mapping'
  | 'invalid_bonus_type_mapping'
  | 'invalid_lottery_result'
  | 'invalid_lottery_weight'
  | 'invalid_material_quantity'

export interface MasterValidationIssue {
  path: string
  code: MasterValidationIssueCode
  message: string
}

export interface MasterValidationResult {
  isValid: boolean
  issues: MasterValidationIssue[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasValidManifestFields(value: Record<string, unknown>): boolean {
  return (
    value.gameTitle === 'Monster Hunter Wilds' &&
    value.appDataKind === 'gogma-artian-planner-master' &&
    typeof value.gameVersion === 'string' &&
    (value.generatedAt === null || typeof value.generatedAt === 'string') &&
    (value.notes === null || typeof value.notes === 'string')
  )
}

function isManifest(value: unknown): value is MasterManifest {
  return (
    isRecord(value) &&
    hasValidManifestFields(value) &&
    Number.isInteger(value.dataVersion) &&
    Number(value.dataVersion) > 0
  )
}

function addIssue(
  issues: MasterValidationIssue[],
  path: string,
  code: MasterValidationIssueCode,
  message: string,
) {
  issues.push({ path, code, message })
}

function validateManifest(
  manifest: MasterManifest,
  issues: MasterValidationIssue[],
) {
  if (!isRecord(manifest) || !hasValidManifestFields(manifest)) {
    addIssue(
      issues,
      'manifest',
      'invalid_manifest',
      'Master manifest fields are invalid.',
    )
  }
  if (!Number.isInteger(manifest.dataVersion) || manifest.dataVersion <= 0) {
    addIssue(
      issues,
      'manifest.dataVersion',
      'invalid_data_version',
      'Master dataVersion must be a positive integer.',
    )
  }
}

function validateUniqueIds(
  collectionName: string,
  values: ReadonlyArray<{ id: string }>,
  issues: MasterValidationIssue[],
) {
  const firstIndexById = new Map<string, number>()
  values.forEach((value, index) => {
    const path = `${collectionName}[${index}].id`
    if (typeof value.id !== 'string' || value.id.trim().length === 0) {
      addIssue(issues, path, 'empty_id', `${collectionName} contains an empty id.`)
      return
    }
    const firstIndex = firstIndexById.get(value.id)
    if (firstIndex !== undefined) {
      addIssue(
        issues,
        path,
        'duplicate_id',
        `${collectionName} id '${value.id}' duplicates index ${firstIndex}.`,
      )
      return
    }
    firstIndexById.set(value.id, index)
  })
}

function validateSortOrders(
  collectionName: string,
  values: ReadonlyArray<{ sortOrder: number }>,
  issues: MasterValidationIssue[],
) {
  values.forEach((value, index) => {
    if (!Number.isFinite(value.sortOrder)) {
      addIssue(
        issues,
        `${collectionName}[${index}].sortOrder`,
        'invalid_sort_order',
        `${collectionName} sortOrder must be a finite number.`,
      )
    }
  })
}

function validateReference(
  path: string,
  id: string,
  targetName: string,
  targetIds: ReadonlySet<string>,
  issues: MasterValidationIssue[],
) {
  if (!targetIds.has(id)) {
    addIssue(
      issues,
      path,
      'missing_reference',
      `Referenced ${targetName} id '${id}' does not exist.`,
    )
  }
}

function validateActiveReference(
  path: string,
  id: string,
  targetName: string,
  activeById: ReadonlyMap<string, boolean>,
  issues: MasterValidationIssue[],
) {
  if (activeById.get(id) === false) {
    addIssue(
      issues,
      path,
      'inactive_reference',
      `Referenced ${targetName} id '${id}' is disabled.`,
    )
  }
}

export function validateMasterData(master: MasterDataRoot): MasterValidationResult {
  const issues: MasterValidationIssue[] = []
  validateManifest(master.manifest, issues)

  const idCollections: Array<[
    string,
    ReadonlyArray<{ id: string }>,
  ]> = [
    ['weaponTypes', master.weaponTypes],
    ['elements', master.elements],
    ['bonusTypes', master.bonusTypes],
    ['bonusRanks', master.bonusRanks],
    ['weaponBonusDefinitions', master.weaponBonusDefinitions],
    ['artianBonusTypeMappings', master.artianBonusTypeMappings],
    ['seriesSkills', master.seriesSkills],
    ['groupSkills', master.groupSkills],
    ['lotteries', master.lotteries],
    ['materials', master.materials],
    ['materialCosts', master.materialCosts],
  ]
  idCollections.forEach(([name, values]) => validateUniqueIds(name, values, issues))

  const orderedCollections: Array<[
    string,
    ReadonlyArray<{ sortOrder: number }>,
  ]> = [
    ['weaponTypes', master.weaponTypes],
    ['elements', master.elements],
    ['bonusTypes', master.bonusTypes],
    ['weaponBonusDefinitions', master.weaponBonusDefinitions],
    ['seriesSkills', master.seriesSkills],
    ['groupSkills', master.groupSkills],
    ['lotteries', master.lotteries],
    ['materials', master.materials],
  ]
  orderedCollections.forEach(([name, values]) =>
    validateSortOrders(name, values, issues),
  )
  master.elements.forEach((element, index) => {
    if (typeof element.allowsElementBonus !== 'boolean') {
      addIssue(
        issues,
        `elements[${index}].allowsElementBonus`,
        'invalid_element_bonus_capability',
        'Element allowsElementBonus must be boolean.',
      )
    }
  })
  master.bonusRanks.forEach((rank, index) => {
    if (!Number.isFinite(rank.order)) {
      addIssue(
        issues,
        `bonusRanks[${index}].order`,
        'invalid_rank_order',
        'Bonus rank order must be a finite number.',
      )
    }
  })

  const weaponTypeIds = new Set(master.weaponTypes.map(({ id }) => id))
  const bonusTypeIds = new Set(master.bonusTypes.map(({ id }) => id))
  const bonusRankIds = new Set(master.bonusRanks.map(({ id }) => id))
  const seriesSkillIds = new Set(master.seriesSkills.map(({ id }) => id))
  const groupSkillIds = new Set(master.groupSkills.map(({ id }) => id))
  const materialIds = new Set(master.materials.map(({ id }) => id))
  const weaponTypeActive = new Map(
    master.weaponTypes.map(({ id, isEnabled }) => [id, isEnabled]),
  )
  const bonusTypeActive = new Map(
    master.bonusTypes.map(({ id, isEnabled }) => [id, isEnabled]),
  )
  const bonusRankActive = new Map(
    master.bonusRanks.map(({ id, isEnabled }) => [id, isEnabled]),
  )
  const seriesSkillActive = new Map(
    master.seriesSkills.map(({ id, isEnabled }) => [id, isEnabled]),
  )
  const groupSkillActive = new Map(
    master.groupSkills.map(({ id, isEnabled }) => [id, isEnabled]),
  )

  const definitionKeys = new Map<string, number>()
  master.weaponBonusDefinitions.forEach((definition, index) => {
    const path = `weaponBonusDefinitions[${index}]`
    if (
      definition.scope !== 'normal_artian' &&
      definition.scope !== 'gogma_artian'
    ) {
      addIssue(
        issues,
        `${path}.scope`,
        'invalid_artian_bonus_scope',
        'Weapon bonus scope must be normal_artian or gogma_artian.',
      )
    }
    validateReference(
      `${path}.weaponTypeId`,
      definition.weaponTypeId,
      'WeaponTypeMaster',
      weaponTypeIds,
      issues,
    )
    validateReference(
      `${path}.bonusTypeId`,
      definition.bonusTypeId,
      'BonusTypeMaster',
      bonusTypeIds,
      issues,
    )
    validateReference(
      `${path}.bonusRankId`,
      definition.bonusRankId,
      'BonusRankMaster',
      bonusRankIds,
      issues,
    )
    validateActiveReference(
      `${path}.bonusTypeId`,
      definition.bonusTypeId,
      'BonusTypeMaster',
      bonusTypeActive,
      issues,
    )
    validateActiveReference(
      `${path}.bonusRankId`,
      definition.bonusRankId,
      'BonusRankMaster',
      bonusRankActive,
      issues,
    )

    const key = `${definition.scope}:${definition.weaponTypeId}:${definition.bonusTypeId}:${definition.bonusRankId}`
    const firstIndex = definitionKeys.get(key)
    if (firstIndex !== undefined) {
      addIssue(
        issues,
        path,
        'duplicate_weapon_bonus_definition',
        `Weapon bonus reference key duplicates index ${firstIndex}.`,
      )
    } else {
      definitionKeys.set(key, index)
    }
  })

  const normalBonusTypes = new Set(
    master.weaponBonusDefinitions
      .filter(
        (definition) =>
          definition.isEnabled && definition.scope === 'normal_artian',
      )
      .map((definition) => definition.bonusTypeId),
  )
  const gogmaBonusTypes = new Set(
    master.weaponBonusDefinitions
      .filter(
        (definition) =>
          definition.isEnabled && definition.scope === 'gogma_artian',
      )
      .map((definition) => definition.bonusTypeId),
  )
  const mappingIndexByNormalType = new Map<string, number>()
  master.artianBonusTypeMappings.forEach((mapping, index) => {
    const path = `artianBonusTypeMappings[${index}]`
    validateReference(
      `${path}.normalBonusTypeId`,
      mapping.normalBonusTypeId,
      'BonusTypeMaster',
      bonusTypeIds,
      issues,
    )
    validateActiveReference(
      `${path}.normalBonusTypeId`,
      mapping.normalBonusTypeId,
      'BonusTypeMaster',
      bonusTypeActive,
      issues,
    )
    validateReference(
      `${path}.gogmaBonusTypeId`,
      mapping.gogmaBonusTypeId,
      'BonusTypeMaster',
      bonusTypeIds,
      issues,
    )
    validateActiveReference(
      `${path}.gogmaBonusTypeId`,
      mapping.gogmaBonusTypeId,
      'BonusTypeMaster',
      bonusTypeActive,
      issues,
    )
    if (!normalBonusTypes.has(mapping.normalBonusTypeId)) {
      addIssue(
        issues,
        `${path}.normalBonusTypeId`,
        'invalid_bonus_type_mapping',
        'Mapping source must be used by a normal_artian bonus definition.',
      )
    }
    if (!gogmaBonusTypes.has(mapping.gogmaBonusTypeId)) {
      addIssue(
        issues,
        `${path}.gogmaBonusTypeId`,
        'invalid_bonus_type_mapping',
        'Mapping target must be used by a gogma_artian bonus definition.',
      )
    }
    const firstIndex = mappingIndexByNormalType.get(mapping.normalBonusTypeId)
    if (firstIndex !== undefined) {
      addIssue(
        issues,
        path,
        'duplicate_bonus_type_mapping',
        `Normal bonus type mapping duplicates index ${firstIndex}.`,
      )
    } else {
      mappingIndexByNormalType.set(mapping.normalBonusTypeId, index)
    }
  })

  master.lotteries.forEach((lottery, index) => {
    const path = `lotteries[${index}]`
    if (!Number.isFinite(lottery.weight) || lottery.weight < 0) {
      addIssue(
        issues,
        `${path}.weight`,
        'invalid_lottery_weight',
        'Lottery weight must be a finite number greater than or equal to zero.',
      )
    }

    if (
      lottery.resultType === 'bonus' &&
      (lottery.bonusTypeId === null || lottery.bonusRankId === null)
    ) {
      addIssue(
        issues,
        `${path}.resultType`,
        'invalid_lottery_result',
        'Bonus lottery results require bonusTypeId and bonusRankId.',
      )
    }
    if (lottery.resultType === 'series_skill' && lottery.seriesSkillId === null) {
      addIssue(
        issues,
        `${path}.seriesSkillId`,
        'invalid_lottery_result',
        'Series skill lottery results require seriesSkillId.',
      )
    }
    if (lottery.resultType === 'group_skill' && lottery.groupSkillId === null) {
      addIssue(
        issues,
        `${path}.groupSkillId`,
        'invalid_lottery_result',
        'Group skill lottery results require groupSkillId.',
      )
    }

    const references: Array<[
      string,
      string | null,
      string,
      ReadonlySet<string>,
      ReadonlyMap<string, boolean>,
    ]> = [
      ['weaponTypeId', lottery.weaponTypeId, 'WeaponTypeMaster', weaponTypeIds, weaponTypeActive],
      ['bonusTypeId', lottery.bonusTypeId, 'BonusTypeMaster', bonusTypeIds, bonusTypeActive],
      ['bonusRankId', lottery.bonusRankId, 'BonusRankMaster', bonusRankIds, bonusRankActive],
      ['seriesSkillId', lottery.seriesSkillId, 'SeriesSkillMaster', seriesSkillIds, seriesSkillActive],
      ['groupSkillId', lottery.groupSkillId, 'GroupSkillMaster', groupSkillIds, groupSkillActive],
    ]
    references.forEach(([field, id, targetName, ids, activeById]) => {
      if (id === null) return
      validateReference(`${path}.${field}`, id, targetName, ids, issues)
      if (lottery.isEnabled) {
        validateActiveReference(
          `${path}.${field}`,
          id,
          targetName,
          activeById,
          issues,
        )
      }
    })
  })

  master.materialCosts.forEach((cost, index) => {
    const path = `materialCosts[${index}]`
    if (!Number.isInteger(cost.quantity) || cost.quantity < 1) {
      addIssue(
        issues,
        `${path}.quantity`,
        'invalid_material_quantity',
        'Material cost quantity must be an integer greater than or equal to one.',
      )
    }
    validateReference(
      `${path}.materialId`,
      cost.materialId,
      'MaterialMaster',
      materialIds,
      issues,
    )
    if (cost.weaponTypeId !== null) {
      validateReference(
        `${path}.weaponTypeId`,
        cost.weaponTypeId,
        'WeaponTypeMaster',
        weaponTypeIds,
        issues,
      )
    }
  })

  return { isValid: issues.length === 0, issues }
}

export function parseMasterManifest(input: unknown): MasterManifest | null {
  return isManifest(input) ? input : null
}
