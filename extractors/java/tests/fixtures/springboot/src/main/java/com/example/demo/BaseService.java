package com.example.demo;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public abstract class BaseService {

    protected final Logger logger = LoggerFactory.getLogger(getClass());

    protected void logAction(String action) {
        logger.info("Performing: {}", action);
    }
}
