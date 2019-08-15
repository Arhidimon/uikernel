/*
 * Copyright (с) 2015-present, SoftIndex LLC.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import EventEmitter from '../common/Events';
import Validator from '../common/validation/Validator';
import ValidationErrors from '../common/validation/ValidationErrors';
import {throttle, parseValueFromEvent, getRecordChanges, isEqual, isEmpty, unwrap, hasOwnProperty} from '../common/utils';
import ThrottleError from '../common/ThrottleError';
// eslint-disable-next-line no-unused-vars
import FormModel from './FormModel';

type FormServiceInitSettings = {
  model: FormModel,
  fields: string[],
  data: {[index: string]: any},
  changes: {[index: string]: any},
  submitAll: boolean,
  partialErrorChecking: boolean,
  showDependentFields: boolean,
  warningsValidator: Validator
};

class FormService {
  public fields: any;
  public model: FormModel | null;
  public showDependentFields: boolean;
  public submitAll: boolean;
  public submitting: boolean;
  public validating: boolean;
  private _changes: {[index: string]: any} | null;
  private _data: {[index: string]: any} | null;
  private _errors: ValidationErrors;
  private _eventEmitter: EventEmitter;
  private _hiddenValidationFields: any[];
  private _isNotInitialized: boolean;
  private _isSubmitting: boolean;
  private _partialErrorChecking: boolean;
  private _partialErrorCheckingDefault: boolean;
  private _warnings: ValidationErrors;
  private _warningsValidator: Validator | null;

  constructor(fields = null) {
    this._changes = null;
    this._data = null;
    this._errors = new ValidationErrors();
    this._eventEmitter = new EventEmitter();
    this._hiddenValidationFields = [];
    this._isNotInitialized = false;
    this._isNotInitialized = true;
    this._isSubmitting = false;
    this._partialErrorChecking = false;
    this._partialErrorCheckingDefault = false;
    this._warnings = new ValidationErrors();
    this._warningsValidator = new Validator();
    this.fields = fields;
    this.model = null;
    this.showDependentFields = false;
    this.submitAll = false;
    this.submitting = false;
    this.validating = false;
    this._getChanges = this._getChanges.bind(this);
    this._getData = this._getData.bind(this);
    this._onModelChange = this._onModelChange.bind(this);
    this._validateForm = throttle(this._validateForm.bind(this));
    this.clearChanges = this.clearChanges.bind(this);
    this.clearError = this.clearError.bind(this);
    this.clearValidation = this.clearValidation.bind(this);
    this.updateField = this.updateField.bind(this);
    this.validateField = this.validateField.bind(this);
    this.validateForm = this.validateForm.bind(this);
  }

  /**
   * Initialize form
   *
   * @param {Object}            settings                                Configuration
   * @param {Array}             settings.fields                         Fields list, that are required to display
   * @param {FormModel}         settings.model                          Model of form
   * @param {Object}            [settings.data]                         Preset data
   * @param {Object}            [settings.changes                       Preset changes
   * @param {bool}              [settings.submitAll=false]              Send all form for validity check
   * @param {bool}              [settings.partialErrorChecking=false]   Activate partial gradual form validation
   * @param {bool}              [settings.showDependentFields=false]    Mark the fields which are involved in the group validation
   * @param {Validator}         [settings.warningsValidator]            Warnings validator for fields
   */

  async init(settings: FormServiceInitSettings) {
    if (!settings.model) {
      throw Error('You must specify the model');
    }

    this._changes = settings.changes || {};
    this._data = settings.data || null;
    this._partialErrorChecking = settings.partialErrorChecking; // Current mode
    this._partialErrorCheckingDefault = settings.partialErrorChecking; // Default mode
    this._warningsValidator = settings.warningsValidator || new Validator();
    this.model = settings.model; // FormModel
    this.showDependentFields = settings.showDependentFields || false;
    this.submitAll = settings.submitAll;

    if (hasOwnProperty(settings, 'fields')) {
      this.fields = settings.fields;
    }
    if (!this._data) {
      this._data = await settings.model.getData(this.fields);
    }

    this.model.on('update', this._onModelChange);
    this._setState();

    if (!settings.partialErrorChecking) {
      await this.validateForm();
    }
  }

  getAll() {
    const isLoaded = this._isLoaded();

    if (!isLoaded) {
      const emptyData: {[index: string]: any} = {
        isLoaded,
        data: {},
        originalData: {},
        changes: {},
        errors: new ValidationErrors(),
        warnings: new ValidationErrors(),
        isSubmitting: false,
      };
      emptyData.fields = this._getFields(emptyData.data, emptyData.changes, emptyData.errors, emptyData.warnings);
      return emptyData;
    }

    const data = this._getData();
    const changes = this._getChangesFields();
    const errors = this._getDisplayedErrors(this._errors);
    const warnings = this._getDisplayedErrors(this._warnings);

    return {
      isLoaded,
      data,
      originalData: this._data,
      changes,
      errors,
      warnings,
      // Note that we return errors and warnings both in bunch as a property and for each field separately
      // - it is redundantly, but handy :)
      fields: this._getFields(data, changes, errors, warnings),
      isSubmitting: this._isSubmitting
    };
  }

  /**
   * Update form value. Is used as the Editors onChange handler
   *
   * @param {string}  field  Parameter
   * @param {*}       value  Event or data
   */
  async updateField(field: string, value: Event) {
    await this.set({
      [field]: parseValueFromEvent(value)
    });
  }

  addChangeListener(func: any) {
    this._eventEmitter.on('update', func);
  }

  removeChangeListener(func: any) {
    this._eventEmitter.off('update', func);
    if (this._eventEmitter.listenerCount('update') === 0 && !this._isNotInitialized) {
      unwrap<FormModel>(this.model, 'Model must be initialized').off('update', this._onModelChange);
    }
  }

  removeAllListeners() {
    this._eventEmitter.removeAllListeners('update');
    unwrap<FormModel>(this.model, 'Model must be initialized').off('update', this._onModelChange);
  }

  /**
   * @param {string|string[]} fields
   */
  clearValidation(fields: string | string[]) {
    if (this._isNotInitialized) {
      return;
    }

    // We keep info about _hiddenValidationFields for cases when clearValidation was called while validateForm was
    // called and haven't finished, so then old validation result shouldn't show errors for _hiddenValidationFields
    // fields, but the next called validations will clear _hiddenValidationFields so the fields will get errors again.
    // Use case: a user changed field 'name', a validation started, the user focused field 'age' so we called
    // clearValidation('age'), the validation finished and returned errors for fields 'name' and 'age', but we
    // shouldn't show error for field 'age' because the user has just focused it. Then user blured field 'age', a new
    // validation stated and it should show errors for field 'age'.
    if (Array.isArray(fields)) {
      this._hiddenValidationFields.push(...fields);
    } else {
      this._hiddenValidationFields.push(fields);
    }

    this._setState();
  }

  clearError(field: string) {
    console.warn('Deprecated: FormService method "clearError" renamed to "clearValidation"');
    this.clearValidation(field);
  }

  async validateField(field: string, value: any) {
    await this.set({
      [field]: parseValueFromEvent(value)
    }, true);
  }

  /**
   * Set data in the form
   *
   * @param {Object}    data              Data
   * @param {bool}      [validate=false]  Validate form
   */
  async set(data: {[index: string]: any}, validate?: boolean) {
    if (!this._isLoaded()) {
      return;
    }

    this._changes = getRecordChanges(unwrap<FormModel>(this.model, 'Model must be initialized'),
      unwrap<{[index: string]: any}>(this._data),
      unwrap<{[index: string]: any}>(this._changes), data);

    this._setState();

    if (validate) {
      try {
        await this.validateForm();
      } catch (e) {
        if (!(e instanceof ThrottleError)) {
          throw e;
        }
      }
    }
  }

  async submitData(data: {[index: string]: any}) {
    if (this._isNotInitialized) {
      return;
    }

    await this.set(data);
    return await this.submit();
  }

  /**
   * Send form data to the model
   */
  async submit() {
    if (this._isNotInitialized || this._isSubmitting) {
      return;
    }

    const changes = this._getChanges();

    this._isSubmitting = true;
    this._partialErrorChecking = false;
    const countOfHiddenValidationFieldsToRemove = this._hiddenValidationFields.length;

    this._setState();

    // Send changes to model
    let data;
    let validationErrors;
    try {
      data = await unwrap(this.model, 'Model must be initialized').submit(changes);
    } catch (err) {
      if (!(err instanceof ValidationErrors)) {
        this._isSubmitting = false;
        this._setState();
        throw err;
      }
      validationErrors = err;
    }

    this._isSubmitting = false;

    const newChanges = this._getChanges();
    const actualChanges = isEqual(changes, newChanges);

    if (actualChanges) {
      if (validationErrors) {
        this._errors = validationErrors;
      } else {
        this._errors = new ValidationErrors();
        this._changes = {};
      }
    }

    this._hiddenValidationFields.splice(0, countOfHiddenValidationFieldsToRemove);

    this._setState();

    if (validationErrors) {
      throw validationErrors;
    }

    return data;
  }

  clearFieldChanges(field: string) {
    if (this._isNotInitialized) {
      return;
    }

    this._errors.clearField(field);
    this._warnings.clearField(field);
    delete unwrap<{[index: string]: any}>(this._changes)[field];
    this._setState();
  }

  clearChanges() {
    if (this._isNotInitialized) {
      return;
    }

    this._errors.clear();
    this._warnings.clear();
    this._changes = {};
    this._partialErrorChecking = this._partialErrorCheckingDefault;
    this._setState();
  }

  setPartialErrorChecking(value: boolean) {
    this._partialErrorChecking = value;
    this._setState();
  }

  getPartialErrorChecking() {
    return this._partialErrorChecking;
  }

  async validateForm() {
    try {
      return await this._validateForm();
    } catch (e) {
      if (!(e instanceof ThrottleError)) {
        throw e;
      }
    }
  }

  async _validateForm() {
    if (this._isNotInitialized) {
      return;
    }

    // We should remove only those hiddenValidationFields that were present before validation started and keep those
    // that were added after validation started (so it is possible and ok that field 'name' may be present 2 times:
    // 1 for old validation call and 1 for the new).
    // Take into account that _validateForm is throttled, so next calls will be skipped or scheduled after current call
    // finishes. It means we don't need to care about parallel calls because they are impossible.
    const countOfHiddenValidationFieldsToRemove = this._hiddenValidationFields.length;
    this.validating = true;

    try {
      await Promise.all([
        this._runValidator(unwrap<FormModel>(this.model, 'Model must be initialized'),
          this._getChanges, '_errors'),
        this._runValidator(unwrap<Validator>(this._warningsValidator), this._getData, '_warnings')
      ]);
    } finally {
      this.validating = false;

      this._hiddenValidationFields.splice(0, countOfHiddenValidationFieldsToRemove);

      this._setState();
    }

    const displayedErrors = this._getDisplayedErrors(this._errors);
    const displayedWarning = this._getDisplayedErrors(this._warnings);

    return {
      errors: !displayedErrors.isEmpty() ? displayedErrors : null,
      warnings: !displayedWarning.isEmpty() ? displayedWarning : null,
    };
  }

  _getFields(data: {[index: string]: any},
    changes: {[index: string]: any},
    errors: ValidationErrors,
    warnings: ValidationErrors) {
    const proxy: {[index: string]: any} = new Proxy({}, {
      get(target, fieldName: string) {
        return {
          value: data[fieldName],
          isChanged: hasOwnProperty(changes, fieldName),
          errors: errors.getFieldErrorMessages(fieldName),
          warnings: warnings.getFieldErrorMessages(fieldName)
        };
      }
    });

    // Explicit declaration of fields in an object
    if (this.fields) {
      for (const field of this.fields) {
        proxy[field] = proxy[field] || undefined;
      }
    }

    return proxy;
  }

  /**
   * Check is data loaded
   *
   * @returns {boolean}
   */
  _isLoaded() {
    return this._data !== null;
  }

  /**
   * Get form changes
   *
   * @return {{}}
   */
  _getChangesFields() { // TODO _getChanges
    const changes: {[index: string]: any} = {};
    for (const field of Object.keys(unwrap<{[index: string]: any}>(this._changes))) {
      if (!this._isDependentField(field)) {
        changes[field] = unwrap<{[index: string]: any}>(this._changes)[field];
      }
    }
    return changes;
  }

  /**
   * Filter errors depending on the partialErrorChecking mode and clearValidation method
   *
   * @param {ValidationErrors}  validationErrors
   * @returns {ValidationErrors} Form fields
   */
  _getDisplayedErrors(validationErrors: ValidationErrors) {
    const filteredErrors = validationErrors.clone();

    for (const field of validationErrors.getErrors().keys()) {
      const isFieldPristine = !(hasOwnProperty(unwrap<{[index: string]: any}>(this._changes), field))
        || isEqual(unwrap<{[index: string]: any}>(this._changes)[field],
          unwrap<{[index: string]: any}>(this._data)[field]);
      if (this._hiddenValidationFields.includes(field) || this._partialErrorChecking && isFieldPristine) {
        filteredErrors.clearField(field);
      }
    }

    return filteredErrors;
  }

  _setState() {
    this._eventEmitter.trigger('update', this.getAll());
  }

  /**
   * Model records changes handler
   *
   * @param {Object} changes  Changes
   * @private
   */
  _onModelChange(changes: {[index: string]: any}) {
    this._data = {...this._data, ...changes};
    this._setState();
  }

  _getData() {
    return Object.assign({},
      unwrap<{[index: string]: any}>(this._data),
      unwrap<{[index: string]: any}>(this._changes));
  }

  _getChanges() {
    // Send all data or just changed fields in addiction of form configuration
    if (this.submitAll) {
      return this._getData();
    }
    return unwrap<{[index: string]: any}>(this._changes);
  }

  _isDependentField(field: string) {
    return (hasOwnProperty(unwrap<{[index: string]: any}>(this._changes), field)) &&
      isEqual(unwrap<{[index: string]: any}>(this._changes)[field], unwrap<{[index: string]: any}>(this._data)[field]);
  }

  async _runValidator(validator: Validator | FormModel, getData: () => {[index: string]: any}, output: '_errors' | '_warnings') {
    const data = getData();
    if (isEmpty(data)) {
      this[output].clear();
      return;
    }
    let validErrors;

    try {
      validErrors = await validator.isValidRecord(data);
    } catch (e) {
      this[output].clear();
      throw e;
    }

    if (isEqual(data, getData())) {
      this[output] = validErrors;
    }
  }
}

export default FormService;