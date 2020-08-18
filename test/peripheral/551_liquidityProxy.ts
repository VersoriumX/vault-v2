const Pool = artifacts.require('Pool')
const LiquidityProxy = artifacts.require('LiquidityProxy')

// @ts-ignore
import helper from 'ganache-time-traveler'
import { CHAI, toWad, toRay, mulRay } from '../shared/utils'
import { YieldEnvironmentLite, Contract } from '../shared/fixtures'
// @ts-ignore
import { BN, expectRevert } from '@openzeppelin/test-helpers'
import { assert, expect } from 'chai'
import { BigNumber } from 'ethers'

contract('LiquidityProxy', async (accounts) => {
  let [owner, user1, operator, user2, to] = accounts

  // These values impact the pool results
  const rate1 = toRay(1.4)
  const daiDebt1 = toWad(96)
  const daiTokens1 = mulRay(daiDebt1, rate1)
  const yDaiTokens1 = daiTokens1

  const oneToken = toWad(1)
  const initialDai = daiTokens1

  let snapshot: any
  let snapshotId: string

  let env: YieldEnvironmentLite
  let controller: Contract
  let chai: Contract

  let dai: Contract
  let pool: Contract
  let yDai1: Contract
  let proxy: Contract
  let treasury: Contract

  let maturity1: number

  const yDaiIn = (daiReserves: BigNumber, yDaiReserves: BigNumber, daiUsed: BigNumber): BigNumber => {
    return daiReserves.mul(daiUsed.div(daiReserves.add(yDaiReserves)))
  }

  beforeEach(async () => {
    snapshot = await helper.takeSnapshot()
    snapshotId = snapshot['result']

    env = await YieldEnvironmentLite.setup()
    dai = env.maker.dai
    chai = env.maker.chai
    dai = env.maker.dai
    controller = env.controller
    treasury = env.treasury

    // Setup yDai
    const block = await web3.eth.getBlockNumber()
    maturity1 = (await web3.eth.getBlock(block)).timestamp + 31556952 // One year
    yDai1 = await env.newYDai(maturity1, 'Name', 'Symbol')

    // Setup Pool
    pool = await Pool.new(dai.address, yDai1.address, 'Name', 'Symbol', { from: owner })

    // Allow owner to mint yDai the sneaky way, without recording a debt in controller
    await yDai1.orchestrate(owner, { from: owner })

    // Setup LiquidityProxy
    proxy = await LiquidityProxy.new(
      dai.address,
      chai.address,
      treasury.address,
      controller.address,
      pool.address,
      { from: owner }
    )
  })

  afterEach(async () => {
    await helper.revertToSnapshot(snapshotId)
  })

  describe('with initial liquidity', () => {
    beforeEach(async () => {
      await env.maker.getDai(user1, initialDai, rate1)
      await dai.approve(pool.address, initialDai, { from: user1 })
      await pool.init(initialDai, { from: user1 })
      const additionalYDaiReserves = toWad(34.4)
      await yDai1.mint(operator, additionalYDaiReserves, { from: owner })
      await yDai1.approve(pool.address, additionalYDaiReserves, { from: operator })
      await pool.sellYDai(operator, operator, additionalYDaiReserves, { from: operator })
    })

    it('mints liquidity tokens with dai only', async () => {
      const oneToken = toWad(1)
      
      const poolTokensBefore = new BN(await pool.balanceOf(user2))
      const daiUsed = oneToken;
      const maxYDai = oneToken

      console.log('          adding liquidity...')
      console.log('          daiReserves: %d', await pool.getDaiReserves())    // d_0
      console.log('          yDaiReserves: %d', await pool.getYDaiReserves())  // y_0
      console.log('          Pool supply: %d', await pool.totalSupply())       // s
      console.log('          daiUsed: %d', daiUsed)                            // d_used

      await dai.mint(user2, oneToken, { from: owner })
      await dai.approve(proxy.address, oneToken, { from: user2 })
      await controller.addDelegate(proxy.address, { from: user2 })
      await proxy.addLiquidity(daiUsed, maxYDai, { from: user2 })

      // https://www.desmos.com/calculator/bl2knrktlt
      const expectedDebt = new BN('376849177280000000')                        // y_in
      const expectedPosted = new BN('314040981060000000')                      // p
      const expectedMinted = new BN('820437684840000000')                      // m

      const posted = new BN(await controller.posted(CHAI, user2))
      const debt = new BN(await controller.debtYDai(CHAI, maturity1, user2))
      const minted = new BN(await pool.balanceOf(user2)).sub(poolTokensBefore)

      //asserts
      assert.equal(
        posted.toString(),
        expectedPosted,
        'User2 should have ' + expectedPosted + ' posted chai, instead has ' + posted.toString()
      )
      assert.equal(
        debt.toString(),
        expectedDebt,
        'User2 should have ' + expectedDebt + ' yDai debt, instead has ' + debt.toString()
      )
      assert.equal(
        minted.toString(),
        expectedMinted,
        'User2 should have ' + expectedMinted + ' pool tokens, instead has ' + minted.toString()
      )
    })

    it('does not allow borrowing more than max amount', async () => {
      const oneToken = toWad(1)
      const one = new BN(oneToken.toString())
      const poolDai = new BN(await dai.balanceOf(pool.address))
      const poolyDai = new BN(await yDai1.balanceOf(pool.address))
      const daiToAdd = poolyDai.mul(one).div(poolyDai.add(poolDai))
      const maxBorrow = daiToAdd.sub(new BN('1')) //subract 1 wei from expected

      await dai.mint(user2, oneToken, { from: owner })
      await dai.approve(proxy.address, oneToken, { from: user2 })
      await controller.addDelegate(proxy.address, { from: user2 })

      await expectRevert(
        proxy.addLiquidity(oneToken, maxBorrow, { from: user2 }),
        'LiquidityProxy: maxYDai exceeded'
      )
    })

    describe('with proxied liquidity', () => {
      beforeEach(async () => {
        const oneToken = toWad(1)
        const maxBorrow = toWad(1)
        await dai.mint(user2, oneToken, { from: owner })
        await dai.approve(proxy.address, oneToken, { from: user2 })
        await controller.addDelegate(proxy.address, { from: user2 })
        await proxy.addLiquidity(oneToken, maxBorrow, { from: user2 })
      })

      it('removes liquidity early by selling', async () => {
        const additionalYDai = toWad(34.4)
        const expectedPoolTokens = '984749191303759738'
        const expectedDai = '986879831174029159'
        const expectedDebt = new BN('252048900155128980')
        const expectedCollateral = new BN('210040750129274150')

        await yDai1.mint(operator, additionalYDai, { from: owner })
        await yDai1.approve(pool.address, additionalYDai, { from: operator })
        await pool.sellYDai(operator, operator, additionalYDai, { from: operator })
        const poolTokens = new BN(await pool.balanceOf(user2))
        await pool.approve(proxy.address, poolTokens, { from: user2 })

        const DaiBefore = new BN(await dai.balanceOf(user2))
        const debt = new BN(await controller.debtYDai(CHAI, maturity1, user2))
        const collateral = new BN(await controller.posted(CHAI, user2))
        assert.equal(poolTokens.toString(), expectedPoolTokens, 'User2 should have poolTokens')
        assert.equal(DaiBefore.toString(), '0', 'User2 should not have Dai')
        assert.equal(debt.toString(), expectedDebt, 'User2 should have debt')
        assert.equal(collateral.toString(), expectedCollateral, 'User2 should have posted Collateral')

        await pool.addDelegate(proxy.address, { from: user2 })
        await proxy.removeLiquidityEarly(poolTokens, '0', { from: user2 })

        const poolTokensAfter = new BN(await pool.balanceOf(user2))
        const DaiAfter = new BN(await dai.balanceOf(user2))
        const debtAfter = new BN(await controller.debtYDai(CHAI, maturity1, user2))
        const collateralAfter = new BN(await controller.posted(CHAI, user2))
        assert.equal(poolTokensAfter, '0', 'User2 should not have poolTokens')
        assert.equal(DaiAfter.toString(), expectedDai, 'User2 should have Dai')
        assert.equal(debtAfter.toString(), '0', 'User2 should not have debt')
        assert.equal(collateralAfter.toString(), '0', 'User2 should not have Collateral')
      })
    })
  })
})
