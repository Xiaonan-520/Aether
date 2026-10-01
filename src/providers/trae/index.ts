/**
 * TRAE provider entry point (CN + INTL share one adapter).
 */
export { createTraeProvider, type TraeProviderOptions } from './provider.js'
export {
  TRAE,
  TRAE_INTL,
  ALL_TRAE_PRODUCTS,
  traeProductById,
  type TraeProduct,
} from './product.js'
